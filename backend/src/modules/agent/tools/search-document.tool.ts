import type { PrismaClient } from "@prisma/client";
import { CragService } from "../../search/retrieval/crag.service.js";
import { LLMReranker } from "../../search/retrieval/reranker.service.js";
import { HybridSearchService } from "../../search/retrieval/hybrid-search.service.js";
import type { SearchResult } from "../../search/retrieval/post-processor.js";
import type { RetrievalMeta } from "../types.js";

interface SearchDocumentToolResult {
  summary: string;
  payload: SearchResult[];
  retrieval: RetrievalMeta;
}

export async function searchDocumentTool(
  prisma: PrismaClient,
  documentId: string,
  query: string,
  topK = 8,
): Promise<SearchDocumentToolResult> {
  const reranker = new LLMReranker();
  const crag = new CragService();
  const search = new HybridSearchService(prisma, reranker);

  const initialResults = await search.search({
    documentIds: [documentId],
    query,
    topK,
  });

  const decision = await crag.evaluate(query, initialResults);
  if (decision.action === "accept") {
    return {
      summary: `检索到 ${initialResults.length} 条相关证据`,
      payload: initialResults,
      retrieval: {
        hitCount: initialResults.length,
        cragAction: decision.action,
        refinedQuery: null,
        usedReranker: "hybrid-heuristic-llm",
      },
    };
  }

  const refinedQuery = decision.action === "refine" ? decision.refinedQuery : decision.newQuery;
  const refinedResults = await search.search({
    documentIds: [documentId],
    query: refinedQuery,
    topK,
  });
  const finalResults = refinedResults.length > 0 ? refinedResults : initialResults;

  return {
    summary: `检索到 ${finalResults.length} 条相关证据（CRAG ${decision.action}）`,
    payload: finalResults,
    retrieval: {
      hitCount: finalResults.length,
      cragAction: decision.action,
      refinedQuery,
      usedReranker: "hybrid-heuristic-llm",
    },
  };
}
