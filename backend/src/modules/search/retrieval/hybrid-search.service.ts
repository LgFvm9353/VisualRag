/**
 * 混合检索服务（2026 生产级标准方案）。
 *
 * 流程:
 *   Query → Dense (HNSW 向量) + BM25 (pg_bigm tsquery)
 *         → RRF 融合 (k=60)
 *         → Parent-Child 映射（小块结果 → 大窗口 Context）
 *         → Rerank
 *         → CRAG 自评
 *         → 后处理 (MMR + 阈值 + 去重)
 */

import type { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { config } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import type { RerankerService } from "./reranker.service.js";
import { postProcess, type SearchResult } from "./post-processor.js";
import type { KnowledgeBaseFileType } from "./query-metadata.js";

export interface HybridSearchParams {
  documentIds?: string[];
  query: string;
  topK?: number;
  /** 可选的页面范围过滤 */
  pageRange?: [number, number];
  /** 是否跳过 rerank（用于快速搜索） */
  skipRerank?: boolean;
  publishedYear?: number | null;
  fileTypes?: KnowledgeBaseFileType[];
  tags?: string[];
}

export class HybridSearchService {
  private openai: OpenAI;

  constructor(
    private prisma: PrismaClient,
    private reranker?: RerankerService,
  ) {
    this.openai = new OpenAI({
      baseURL: config.embedding.baseURL,
      apiKey: config.embedding.apiKey,
    });
  }

  private async resolveDocumentIds(params: HybridSearchParams): Promise<string[]> {
    if (params.documentIds?.length) return params.documentIds;

    const documents = await this.prisma.document.findMany({
      where: {
        status: "ready",
        ...(params.fileTypes?.length ? { fileType: { in: params.fileTypes } } : {}),
        ...(params.tags?.length ? { tags: { hasEvery: params.tags } } : {}),
        ...(params.publishedYear
          ? {
              publishedAt: {
                gte: new Date(`${params.publishedYear}-01-01T00:00:00.000Z`),
                lt: new Date(`${params.publishedYear + 1}-01-01T00:00:00.000Z`),
              },
            }
          : {}),
      },
      select: { id: true },
    });

    return documents.map((document) => document.id);
  }

  /**
   * 混合检索主入口。
   */
  async search(params: HybridSearchParams): Promise<SearchResult[]> {
    const documentIds = await this.resolveDocumentIds(params);
    if (documentIds.length === 0) return [];

    const { query, topK = 10, pageRange, skipRerank = false } = params;
    const fetchK = topK * 3; // 多取一些给 rerank 用

    // Step 1: 并行 Dense + BM25
    const [denseResults, bm25Results] = await Promise.all([
      this.denseSearch(query, documentIds, fetchK, pageRange),
      this.bm25Search(query, documentIds, fetchK, pageRange),
    ]);

    logger.info(
      { documentIds, query: query.slice(0, 80), topK, denseCount: denseResults.length, bm25Count: bm25Results.length },
      "[hybridSearch] 混合检索完成",
    );

    // Step 2: RRF 融合
    const fused = this.rrfFusion(denseResults, bm25Results, { k: 60 });

    // Step 3: Parent-Child 映射（Child chunk → Parent context）
    const withContext = await this.mapToParentContext(fused);

    // Step 4: Rerank
    let reranked: SearchResult[];
    if (!skipRerank && this.reranker && withContext.length > 0) {
      reranked = await this.reranker.rerank(query, withContext, Math.min(topK * 2, withContext.length));
    } else {
      reranked = withContext.slice(0, topK * 2);
    }

    // Step 5: 后处理
    const final = postProcess(reranked, {
      threshold: 0.3,
      deduplicate: true,
    });

    if (final.length === 0 && reranked.length > 0) {
      logger.warn(
        {
          documentIds,
          query: query.slice(0, 80),
          rerankedCount: reranked.length,
        },
        "[hybridSearch] 阈值过滤后结果为空，回退到无阈值后处理",
      );
      return postProcess(reranked, {
        deduplicate: true,
      }).slice(0, topK);
    }

    return final.slice(0, topK);
  }

  /**
   * Dense 向量检索（使用 ChunkEmbedding 表 + HNSW 索引）。
   */
  private async denseSearch(
    query: string,
    documentIds: string[],
    limit: number,
    pageRange?: [number, number],
  ): Promise<SearchResult[]> {
    try {
      // 设置 HNSW 搜索参数
      await this.prisma.$executeRaw`SET LOCAL hnsw.ef_search = 100;`;

      const embeddingResp = await this.openai.embeddings.create({
        model: config.embedding.model,
        input: query,
      });
      const embedding = embeddingResp.data[0]?.embedding;
      if (!embedding || embedding.length === 0) return [];

      const embeddingLiteral = `[${embedding.join(",")}]`;
      const docIdsLiteral = `{${documentIds.join(",")}}`;

      const rows = await this.prisma.$queryRaw<
        { chunkId: string; content: string; documentId: string; pageNumber: number; similarity: number }[]
      >`
        SELECT
          c.id as "chunkId",
          c.content as "content",
          c."documentId" as "documentId",
          COALESCE(ds."pageNumber", ds.index)::int as "pageNumber",
          1 - (ce.embedding <=> ${embeddingLiteral}::vector) as "similarity"
        FROM "ChunkEmbedding" ce
        JOIN "Chunk" c ON c.id = ce."chunkId"
        JOIN "DocumentSection" ds ON ds.id = c."sectionId"
        WHERE ce."documentId"::text = ANY(${docIdsLiteral}::text[])
        ORDER BY "similarity" DESC
        LIMIT ${limit};
      `;

      return rows.map((r) => ({
        documentId: r.documentId,
        pageNumber: r.pageNumber,
        snippet: r.content.slice(0, 500),
        fullContent: r.content,
        chunkId: r.chunkId,
        similarity: r.similarity,
        source: "dense" as const,
      }));
    } catch (err) {
      logger.error({ err }, "Dense 检索失败");
      return [];
    }
  }

  /**
   * BM25 关键词检索。
   *
   * - 中文查询: 使用字符 bigram + ILIKE 模糊匹配（因为 pg_bigm 扩展未安装，
   *   to_tsvector('simple') 对中文不进行分词，tsquery @@ 始终无法命中）。
   * - 非中文查询: 使用 PostgreSQL tsvector/tsquery（simple 配置）。
   */
  private async bm25Search(
    query: string,
    documentIds: string[],
    limit: number,
    _pageRange?: [number, number],
  ): Promise<SearchResult[]> {
    try {
      const docIdsLiteral = `{${documentIds.join(",")}}`;

      // ---- 中文查询：字符 bigram + ILIKE ----
      const hasChinese = /[一-鿿]/.test(query);
      if (hasChinese) {
        return await this.bm25ChineseBigram(query, docIdsLiteral, limit);
      }

      // ---- 非中文查询：tsquery（原有逻辑）----
      const terms = query
        .replace(/[，,。；;！!？?、\s]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      if (terms.length === 0) return [];

      // 尝试 tsquery，如果失败则 ILIKE fallback
      try {
        const tsquery = terms.map((t) => `'${t}'`).join(" & ");
        const rows = await this.prisma.$queryRaw<
          { chunkId: string; content: string; documentId: string; pageNumber: number; rank: number }[]
        >`
          SELECT
            c.id as "chunkId",
            c.content as "content",
            c."documentId" as "documentId",
            COALESCE(ds."pageNumber", ds.index)::int as "pageNumber",
            ts_rank(
              to_tsvector('simple', c.content),
              to_tsquery('simple', ${tsquery})
            ) as "rank"
          FROM "Chunk" c
          JOIN "DocumentSection" ds ON ds.id = c."sectionId"
          WHERE c."documentId"::text = ANY(${docIdsLiteral}::text[])
            AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${tsquery})
          ORDER BY "rank" DESC
          LIMIT ${limit};
        `;
        return rows.map((r) => ({
          documentId: r.documentId,
          pageNumber: r.pageNumber,
          snippet: r.content.slice(0, 500),
          fullContent: r.content,
          chunkId: r.chunkId,
          similarity: r.rank,
          source: "bm25" as const,
        }));
      } catch {
        // tsquery 失败 → ILIKE fallback
        const rows = await this.prisma.chunk.findMany({
          where: {
            documentId: { in: documentIds },
            content: { contains: query, mode: "insensitive" },
          },
          include: { section: true },
          take: limit,
          orderBy: { chunkIndex: "asc" },
        });
        return rows.map((r) => ({
          documentId: r.documentId,
          pageNumber: r.section?.pageNumber ?? r.section?.index ?? 0,
          snippet: r.content.slice(0, 500),
          fullContent: r.content,
          chunkId: r.id,
          similarity: 0.5,
          source: "bm25" as const,
        }));
      }
    } catch (err) {
      logger.warn({ err }, "BM25 检索降级");
      return [];
    }
  }

  /**
   * 中文 bigram ILIKE 关键词匹配。
   *
   * 原理: 中文没有空格分词，to_tsvector('simple') 不会对中文字符进行 tokenize，
   * 因此 tsquery @@ 匹配对中文始终失败。字符 bigram（相邻两字）是中文文本匹配
   * 的有效近似 —— 如果查询和文档共享多个 bigram，则语义高度相关。
   *
   * 例如查询 "这个文档讲了什么" 生成 bigram:
   *   ["这个", "个文", "文档", "档讲", "讲了", "了什", "什么"]
   * 然后用 ILIKE '%这个%' OR ILIKE '%个文%' OR ... 在 Chunk.content 中匹配。
   */
  private async bm25ChineseBigram(
    query: string,
    docIdsLiteral: string,
    limit: number,
  ): Promise<SearchResult[]> {
    // 清洗查询文本：移除标点、空白
    const cleanQuery = query.replace(/[\s，,。；;！!？?、""''「」『』【】《》…—\-　]+/g, "");
    if (cleanQuery.length < 2) {
      // 单字查询退化为简单 ILIKE
      try {
        const rows = await this.prisma.$queryRawUnsafe<
          { chunkId: string; content: string; documentId: string; pageNumber: number; rank: number }[]
        >(
          `SELECT
            c.id as "chunkId",
            c.content as "content",
            c."documentId" as "documentId",
            COALESCE(ds."pageNumber", ds.index)::int as "pageNumber",
            0.5::float8 as "rank"
          FROM "Chunk" c
          JOIN "DocumentSection" ds ON ds.id = c."sectionId"
          WHERE c."documentId"::text = ANY($1::text[])
            AND c.content ILIKE '%' || $2 || '%'
          LIMIT $3`,
          docIdsLiteral,
          cleanQuery,
          limit,
        );
        return rows.map((r) => ({
          documentId: r.documentId,
          pageNumber: r.pageNumber,
          snippet: r.content.slice(0, 500),
          fullContent: r.content,
          chunkId: r.chunkId,
          similarity: r.rank,
          source: "bm25" as const,
        }));
      } catch (err) {
        logger.warn({ err }, "BM25 中文单字 ILIKE 失败");
        return [];
      }
    }

    // 生成字符 bigram（滑动窗口，步长 1）
    const bigrams: string[] = [];
    for (let i = 0; i < cleanQuery.length - 1; i++) {
      bigrams.push(cleanQuery.slice(i, i + 2));
    }
    // 去重 + 限制数量（避免 SQL 过长）
    const uniqueBigrams = [...new Set(bigrams)].slice(0, 16);

    if (uniqueBigrams.length === 0) return [];

    // 构建 ILIKE OR 条件
    const conditions = uniqueBigrams
      .map((_, i) => `c.content ILIKE '%' || $${i + 2} || '%'`)
      .join(" OR ");

    try {
      const rows = await this.prisma.$queryRawUnsafe<
        { chunkId: string; content: string; documentId: string; pageNumber: number; rank: number }[]
      >(
        `SELECT
          c.id as "chunkId",
          c.content as "content",
          c."documentId" as "documentId",
          COALESCE(ds."pageNumber", ds.index)::int as "pageNumber",
          (
            SELECT count(*) FROM unnest(ARRAY[${uniqueBigrams.map((_, i) => `$${i + 2}`).join(", ")}]) AS bg
            WHERE c.content ILIKE '%' || bg || '%'
          )::float8 / ${uniqueBigrams.length}::float8 as "rank"
        FROM "Chunk" c
        JOIN "DocumentSection" ds ON ds.id = c."sectionId"
        WHERE c."documentId"::text = ANY($1::text[])
          AND (${conditions})
        ORDER BY "rank" DESC
        LIMIT $${uniqueBigrams.length + 2}`,
        docIdsLiteral,
        ...uniqueBigrams,
        limit,
      );

      return rows.map((r) => ({
        documentId: r.documentId,
        pageNumber: r.pageNumber,
        snippet: r.content.slice(0, 500),
        fullContent: r.content,
        chunkId: r.chunkId,
        similarity: r.rank,
        source: "bm25" as const,
      }));
    } catch (err) {
      logger.warn({ err }, "BM25 中文 bigram ILIKE 失败");
      return [];
    }
  }

  /**
   * RRF (Reciprocal Rank Fusion) 融合。
   * score(d) = Σ 1/(k + rank_i(d))
   */
  private rrfFusion(
    denseResults: SearchResult[],
    bm25Results: SearchResult[],
    { k = 60 }: { k?: number } = {},
  ): SearchResult[] {
    const scoreMap = new Map<string, { result: SearchResult; score: number }>();

    const rankList = [
      { results: denseResults, weight: 1.0 },
      { results: bm25Results, weight: 0.8 }, // BM25 权重略低
    ];

    for (const { results, weight } of rankList) {
      results.forEach((r, rank) => {
        const key = r.chunkId || `${r.documentId}:${r.pageNumber}:${r.snippet}`;
        const rrfScore = weight / (k + rank + 1);
        const existing = scoreMap.get(key);
        if (existing) {
          existing.score += rrfScore;
          // 保留相似度更高的
          if ((r.similarity ?? 0) > (existing.result.similarity ?? 0)) {
            existing.result = r;
          }
        } else {
          scoreMap.set(key, { result: r, score: rrfScore });
        }
      });
    }

    return Array.from(scoreMap.values())
      .map((v) => ({ ...v.result, rrfScore: v.score }))
      .sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));
  }

  /**
   * Parent-Child 映射：将检索到的 Child chunk 映射到其 Parent Context。
   */
  private async mapToParentContext(results: SearchResult[]): Promise<SearchResult[]> {
    const chunkIds = results
      .map((r) => r.chunkId)
      .filter(Boolean) as string[];

    if (chunkIds.length === 0) return results;

    // 查找包含这些 child chunk 的 parent context
    const contexts = await this.prisma.chunkContext.findMany({
      where: {
        childChunkIds: { hasSome: chunkIds },
      },
    });

    if (contexts.length === 0) return results;

    // 去重并映射
    const seenContextIds = new Set<string>();
    const mappedResults: SearchResult[] = [];

    for (const result of results) {
      const parent = contexts.find(
        (ctx) => result.chunkId && ctx.childChunkIds.includes(result.chunkId),
      );
      if (parent && !seenContextIds.has(parent.id)) {
        seenContextIds.add(parent.id);
        mappedResults.push({
          ...result,
          fullContent: parent.content, // 用 parent context 替换
          parentContextId: parent.id,
        });
      } else if (!parent) {
        mappedResults.push(result);
      }
    }

    return mappedResults;
  }
}
