/**
 * Chunking 服务 — 2026 RAG 检索增强核心。
 *
 * 流程:
 *   1. 递归分块（512 token, 64 token overlap）
 *   2. Contextual Retrieval: LLM 为每个 chunk 生成文档上下文前缀
 *   3. Parent-Child: 构建更大窗口的上下文块
 *   4. 写入 Chunk / ChunkContext 表
 */

import type { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { config } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { recursiveChunk, type ChunkResult } from "./strategies/recursive-chunker.js";

export interface ChunkRecord {
  id: string;
  documentId: string;
  sectionId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
  contextPrefix: string | null;
  section?: {
    pageNumber: number | null;
    title: string | null;
  };
}

export interface ChunkContextRecord {
  id: string;
  documentId: string;
  sectionId: string;
  content: string;
  childChunkIds: string[];
  startOffset: number;
  endOffset: number;
}

const CONTEXT_PROMPT = `你是一个文档分析助手。请用 1-2 句简短的话描述以下文本片段所属的文档和章节上下文。

要求:
- 说明这是什么类型的文档（如财报、论文、合同、手册等）
- 说明该片段在文档中的大致位置（如第X章、开头/中间/结尾）
- 只输出上下文描述，不要重复原文内容
- 用中文输出
- 不超过 50 个字

文本片段:
{chunk}

上下文描述:`;

export class ChunkingService {
  private openai: OpenAI;

  constructor(private prisma: PrismaClient) {
    this.openai = new OpenAI({
      baseURL: config.chat.baseURL,
      apiKey: config.chat.apiKey,
    });
  }

  /**
   * 对单个文档执行完整的分块流程。
   */
  async chunkDocument(
    documentId: string,
    sections: { id: string; pageNumber?: number | null; content: string; title?: string | null }[],
    options?: {
      skipContextualRetrieval?: boolean;
      chunkSize?: number;
      chunkOverlap?: number;
    },
  ): Promise<{ chunks: ChunkRecord[]; contexts: ChunkContextRecord[] }> {
    const chunkSize = options?.chunkSize ?? config.chunking.chunkSize;
    const chunkOverlap = options?.chunkOverlap ?? config.chunking.chunkOverlap;

    // Step 1: 递归分块（逐页）
    logger.info({ documentId, sections: sections.length }, "开始递归分块");
    const allChunks: (ChunkResult & { sectionId: string; pageNumber?: number | null })[] = [];

    for (const section of sections) {
      let baseOffset = 0;
      const sectionChunks = recursiveChunk(section.content, baseOffset, {
        chunkSize,
        chunkOverlap,
      });
      for (const c of sectionChunks) {
        allChunks.push({ ...c, sectionId: section.id, pageNumber: section.pageNumber ?? undefined });
      }
    }
    logger.info({ documentId, chunkCount: allChunks.length }, "递归分块完成");

    // Step 2: Contextual Retrieval — 为每个 chunk 生成上下文前缀
    const skipContext = options?.skipContextualRetrieval ?? false;
    const contextPrefixes = skipContext
      ? allChunks.map(() => null)
      : await this.generateContextPrefixes(documentId, allChunks);

    // Step 3: 构建 Parent Context 窗口
    const parentContexts = this.buildParentContexts(allChunks, sections, chunkSize);

    // Step 4: 写入数据库
    const chunkRecords: ChunkRecord[] = [];
    const chunkIds: string[] = [];

    for (let i = 0; i < allChunks.length; i++) {
      const c = allChunks[i];
      const prefix = contextPrefixes[i];
      const fullContent = prefix ? `${prefix}\n${c.content}` : c.content;

      const record = await this.prisma.chunk.create({
        data: {
          documentId,
          sectionId: c.sectionId,
          chunkIndex: i,
          content: fullContent,
          tokenCount: c.tokenCount,
          startOffset: c.startOffset,
          endOffset: c.endOffset,
          contextPrefix: prefix,
        },
      });
      chunkRecords.push({
        id: record.id,
        documentId,
        sectionId: c.sectionId,
        chunkIndex: record.chunkIndex,
        content: record.content,
        tokenCount: record.tokenCount ?? 0,
        startOffset: record.startOffset,
        endOffset: record.endOffset,
        contextPrefix: record.contextPrefix,
        section: {
          pageNumber: c.pageNumber ?? null,
          title: sections.find((s) => s.id === c.sectionId)?.title ?? null,
        },
      });
      chunkIds.push(record.id);
    }

    // 写入 Parent Context
    const contextRecords: ChunkContextRecord[] = [];
    const contextChunkMapping: string[][] = parentContexts.map((pc) => {
      // 找出该 parent context 包含哪些 child chunk
      const childIds: string[] = [];
      for (let i = 0; i < allChunks.length; i++) {
        const c = allChunks[i];
        if (c.startOffset >= pc.startOffset && c.endOffset <= pc.endOffset) {
          childIds.push(chunkIds[i]);
        }
      }
      return childIds;
    });

    for (let i = 0; i < parentContexts.length; i++) {
      const pc = parentContexts[i];
      const record = await this.prisma.chunkContext.create({
        data: {
          documentId,
          sectionId: pc.sectionId,
          content: pc.content,
          childChunkIds: contextChunkMapping[i],
          startOffset: pc.startOffset,
          endOffset: pc.endOffset,
        },
      });
      contextRecords.push({
        id: record.id,
        documentId,
        sectionId: pc.sectionId,
        content: record.content,
        childChunkIds: record.childChunkIds,
        startOffset: record.startOffset,
        endOffset: record.endOffset,
      });
    }

    logger.info(
      { documentId, chunks: chunkRecords.length, contexts: contextRecords.length },
      "分块写入完成",
    );
    return { chunks: chunkRecords, contexts: contextRecords };
  }

  /**
   * Contextual Retrieval: 用 LLM 为每个 chunk 生成文档上下文。
   * 生产环境可能需要对大量 chunk 做批处理/限流。
   */
  private async generateContextPrefixes(
    documentId: string,
    chunks: (ChunkResult & { sectionId: string; pageNumber?: number | null })[],
  ): Promise<(string | null)[]> {
    // 只对前 N 个独立 chunk 生成上下文（避免一次性调用过多）
    // 实际场景：抽取代表性 chunk 生成上下文，相同页面/章节的 chunk 共享
    const sampledChunks = this.sampleChunksForContext(chunks, 20);
    const sampledResults = new Map<number, string>();

    for (const { index, chunk } of sampledChunks) {
      try {
        const response = await this.openai.chat.completions.create({
          model: config.chat.model,
          messages: [
            {
              role: "user",
              content: CONTEXT_PROMPT.replace("{chunk}", chunk.content.slice(0, 800)),
            },
          ],
          max_tokens: 80,
          temperature: 0.3,
        });
        const context = response.choices[0]?.message?.content?.trim() || null;
        if (context) sampledResults.set(index, context);
      } catch (err) {
        logger.warn({ err, chunkIndex: index }, "上下文生成失败，跳过该 chunk");
      }
    }

    // 将采样结果扩散到相邻 chunk
    const result: (string | null)[] = [];
    let lastContext: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      if (sampledResults.has(i)) {
        lastContext = sampledResults.get(i)!;
      }
      result.push(lastContext);
    }
    return result;
  }

  /**
   * 采样代表性 chunk 用于生成上下文。
   * 每页取第一个和中间的 chunk。
   */
  private sampleChunksForContext(
    chunks: (ChunkResult & { sectionId: string; pageNumber?: number | null })[],
    maxSamples: number,
  ): { index: number; chunk: ChunkResult }[] {
    const bySection = new Map<string, { index: number; chunk: ChunkResult }[]>();
    chunks.forEach((c, i) => {
      const list = bySection.get(c.sectionId) ?? [];
      list.push({ index: i, chunk: c });
      bySection.set(c.sectionId, list);
    });

    const samples: { index: number; chunk: ChunkResult }[] = [];
    for (const [, sectionChunks] of bySection) {
      if (samples.length >= maxSamples) break;
      // 取第一个
      samples.push(sectionChunks[0]);
      // 取中间的
      if (sectionChunks.length > 2 && samples.length < maxSamples) {
        const mid = Math.floor(sectionChunks.length / 2);
        samples.push(sectionChunks[mid]);
      }
    }
    return samples.slice(0, maxSamples);
  }

  /**
   * 构建 Parent Context 窗口（Parent-Child 检索的返回层）。
   * 每个 parent 覆盖约 3-5 个 child chunk 的上下文。
   */
  private buildParentContexts(
    chunks: (ChunkResult & { sectionId: string; pageNumber?: number | null })[],
    sections: { id: string; pageNumber?: number | null; content: string }[],
    childChunkSize: number,
  ): { sectionId: string; content: string; startOffset: number; endOffset: number }[] {
    const parentSize = config.chunking.parentSize;
    const parentCharSize = parentSize * 2;
    const parents: {
      sectionId: string;
      content: string;
      startOffset: number;
      endOffset: number;
    }[] = [];

    // 按 section 构建 parent
    for (const section of sections) {
      const sectionChunks = chunks.filter((c) => c.sectionId === section.id);
      if (sectionChunks.length === 0) continue;

      let currentStart = sectionChunks[0].startOffset;
      let currentText = "";
      let currentChunks: typeof sectionChunks = [];

      for (const chunk of sectionChunks) {
        if (currentText.length + chunk.content.length > parentCharSize && currentChunks.length > 0) {
          const endOffset = currentChunks[currentChunks.length - 1].endOffset;
          parents.push({
            sectionId: section.id,
            content: section.content.slice(currentStart, endOffset),
            startOffset: currentStart,
            endOffset,
          });
          currentStart = chunk.startOffset;
          currentText = chunk.content;
          currentChunks = [chunk];
        } else {
          currentText += chunk.content;
          currentChunks.push(chunk);
        }
      }

      // 最后一个 parent
      if (currentChunks.length > 0) {
        const endOffset = currentChunks[currentChunks.length - 1].endOffset;
        parents.push({
          sectionId: section.id,
          content: section.content.slice(currentStart, endOffset),
          startOffset: currentStart,
          endOffset,
        });
      }
    }

    return parents;
  }
}
