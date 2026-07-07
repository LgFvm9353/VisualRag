import type { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { config } from "../../config/env.js";
import { EmbeddingNotConfiguredError } from "../../lib/errors.js";

interface SemanticSearchResultItem {
  documentId: string;
  pageNumber: number;
  snippet: string;
  regionIds: string[];
}

const openai = new OpenAI({
  baseURL: config.embedding.baseURL,
  apiKey: config.embedding.apiKey,
});

/**
 * 语义搜索（使用新 Schema: DocumentSection + ChunkEmbedding）。
 */
export async function semanticSearch(
  prisma: PrismaClient,
  documentId: string,
  query: string,
  limit?: number,
): Promise<SemanticSearchResultItem[]> {
  const effectiveLimit = limit ?? 10;

  // Step 1: 关键字 fallback（通过 DocumentSection）
  const keywordMatches = await prisma.documentSection.findMany({
    where: { documentId, content: { contains: query } },
    orderBy: { index: "asc" },
    take: effectiveLimit,
  });

  if (keywordMatches.length > 0) {
    return keywordMatches.map((m) => ({
      documentId,
      pageNumber: m.pageNumber ?? m.index,
      snippet: buildSnippet(m.content, query),
      regionIds: [],
    }));
  }

  if (!config.embedding.apiKey) {
    throw new EmbeddingNotConfiguredError();
  }

  // Step 2: 向量检索（通过 ChunkEmbedding → Chunk → DocumentSection）
  const embeddingResponse = await openai.embeddings.create({
    model: config.embedding.model,
    input: query,
  });
  const embedding = embeddingResponse.data[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    // fallback to keyword
    const fallback = await prisma.documentSection.findMany({
      where: { documentId, content: { contains: query } },
      orderBy: { index: "asc" },
      take: effectiveLimit,
    });
    return fallback.map((m) => ({
      documentId,
      pageNumber: m.pageNumber ?? m.index,
      snippet: buildSnippet(m.content, query),
      regionIds: [],
    }));
  }

  const embeddingLiteral = `[${embedding.join(",")}]`;
  try {
    const rows = await prisma.$queryRaw<
      { chunkId: string; pageNumber: number; content: string; similarity: number }[]
    >`
      SELECT
        c.id as "chunkId",
        COALESCE(ds."pageNumber", ds.index) as "pageNumber",
        c.content as "content",
        1 - (ce.embedding <=> ${embeddingLiteral}::vector) as "similarity"
      FROM "ChunkEmbedding" ce
      JOIN "Chunk" c ON c.id = ce."chunkId"
      JOIN "DocumentSection" ds ON ds.id = c."sectionId"
      WHERE ce."documentId" = ${documentId}::uuid
      ORDER BY "similarity" DESC
      LIMIT ${effectiveLimit};
    `;

    return rows.map((row) => ({
      documentId,
      pageNumber: row.pageNumber,
      snippet: buildSnippet(row.content, query),
      regionIds: [],
    }));
  } catch {
    // 向量检索失败 → keyword fallback
    const fallback = await prisma.documentSection.findMany({
      where: { documentId, content: { contains: query } },
      orderBy: { index: "asc" },
      take: effectiveLimit,
    });
    return fallback.map((m) => ({
      documentId,
      pageNumber: m.pageNumber ?? m.index,
      snippet: buildSnippet(m.content, query),
      regionIds: [],
    }));
  }
}

function buildSnippet(text: string, query: string, window = 60): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return text.slice(0, window * 2);
  }
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + query.length + window);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end) +
    (end < text.length ? "…" : "")
  );
}
