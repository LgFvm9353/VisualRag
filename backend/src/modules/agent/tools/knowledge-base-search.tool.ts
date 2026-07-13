import { assessEvidence, type EvidenceAssessment } from "../../search/retrieval/evidence-gate.js";
import { extractQueryMetadata, type QueryMetadataFilters } from "../../search/retrieval/query-metadata.js";
import type { HybridSearchParams } from "../../search/retrieval/hybrid-search.service.js";
import type { SearchResult } from "../../search/retrieval/post-processor.js";

export interface KnowledgeBaseSearchService {
  search(params: HybridSearchParams): Promise<SearchResult[]>;
}

export type KnowledgeBaseSearchOutput = {
  query: string;
  round: 1 | 2;
  filters: QueryMetadataFilters;
  results: SearchResult[];
  assessment: EvidenceAssessment;
  durationMs: number;
};

export class KnowledgeBaseSearchTool {
  constructor(private readonly searchService: KnowledgeBaseSearchService) {}

  async execute(input: { query: string; round: 1 | 2 }): Promise<KnowledgeBaseSearchOutput> {
    const startedAt = Date.now();
    const filters = extractQueryMetadata(input.query);
    const results = await this.searchService.search({
      query: filters.residualQuery || input.query,
      topK: 8,
      publishedYear: filters.publishedYear,
      fileTypes: filters.fileTypes,
      tags: filters.tags,
    });
    return {
      query: input.query,
      round: input.round,
      filters,
      results,
      assessment: assessEvidence(results),
      durationMs: Date.now() - startedAt,
    };
  }
}
