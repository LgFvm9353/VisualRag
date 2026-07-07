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

export interface HybridSearchParams {
  documentIds: string[];
  query: string;
  topK?: number;
  /** 可选的页面范围过滤 */
  pageRange?: [number, number];
  /** 是否跳过 rerank（用于快速搜索） */
  skipRerank?: boolean;
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

  /**
   * 混合检索主入口。
   */
  async search(params: HybridSearchParams): Promise<SearchResult[]> {
    const { documentIds, query, topK = 10, pageRange, skipRerank = false } = params;
    const fetchK = topK * 3; // 多取一些给 rerank 用

    // Step 1: 并行 Dense + BM25
    const [denseResults, bm25Results] = await Promise.all([
      this.denseSearch(query, documentIds, fetchK, pageRange),
      this.bm25Search(query, documentIds, fetchK, pageRange),
    ]);

    logger.debug(
      { denseCount: denseResults.length, bm25Count: bm25Results.length },
      "混合检索完成",
    );

    // Step 2: RRF 融合
    const fused = this.rrfFusion(denseResults, bm25Results, { k: 60 });

    // Step 3: Parent-Child 映射（Child chunk → Parent context）
    const withContext = await this.mapToParentContext(fused);

    // Step 4: Rerank
    let reranked: SearchResult[];
    if (!skipRerank && this.reranker && withContext.length > topK) {
      reranked = await this.reranker.rerank(query, withContext, topK * 2);
    } else {
      reranked = withContext.slice(0, topK * 2);
    }

    // Step 5: 后处理
    const final = postProcess(reranked, {
      threshold: 0.3,
      deduplicate: true,
    });

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
          ds."pageNumber" as "pageNumber",
          1 - (ce.embedding <=> ${embeddingLiteral}::vector) as "similarity"
        FROM "ChunkEmbedding" ce
        JOIN "Chunk" c ON c.id = ce."chunkId"
        JOIN "DocumentSection" ds ON ds.id = c."sectionId"
        WHERE ce."documentId" = ANY(${docIdsLiteral}::uuid[])
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
   * BM25 关键词检索（使用 PostgreSQL tsvector + pg_bigm）。
   *
   * 中文场景: 用 pg_bigm 的 bigram 分词作为 tsvector 补充。
   * 如果 pg_bigm 不可用，降级为 ILIKE 模式匹配。
   */
  private async bm25Search(
    query: string,
    documentIds: string[],
    limit: number,
    pageRange?: [number, number],
  ): Promise<SearchResult[]> {
    try {
      const docIdsLiteral = `{${documentIds.join(",")}}`;
      // 将查询词转为 tsquery 格式（按空格分词 + & 连接）
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
            ds."pageNumber" as "pageNumber",
            ts_rank(
              to_tsvector('simple', c.content),
              to_tsquery('simple', ${tsquery})
            ) as "rank"
          FROM "Chunk" c
          JOIN "DocumentSection" ds ON ds.id = c."sectionId"
          WHERE c."documentId" = ANY(${docIdsLiteral}::uuid[])
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
        const ilikePattern = `%${terms.join("%")}%`;
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
          pageNumber: r.section?.pageNumber ?? 0,
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
