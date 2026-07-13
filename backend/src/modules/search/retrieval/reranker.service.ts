/**
 * Reranker 服务 — 2026 单项 ROI 最高的检索优化。
 *
 * 当前实现: 轻量启发式重排为主，LLM 仅对少量候选做精排 fallback。
 * 目标：避免对所有 chunk 做逐条 LLM 打分，降低时延与成本。
 */

import OpenAI from "openai";
import { config } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import type { SearchResult } from "./post-processor.js";

const RERANK_PROMPT = `你是一个文档相关性评估助手。请评估以下文档片段对回答用户问题的相关性。

评分标准 (1-10):
- 1-3: 不相关或仅表面相关
- 4-6: 部分相关，但缺少关键信息
- 7-8: 相关，包含有用信息
- 9-10: 高度相关，直接回答了问题

用户问题: {query}

文档片段: {content}

请**只输出一个 1-10 的数字**，不要输出其他内容。`;

export interface RerankerService {
  rerank(query: string, results: SearchResult[], topN: number): Promise<SearchResult[]>;
}

export class LLMReranker implements RerankerService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: config.chat.baseURL,
      apiKey: config.chat.apiKey,
    });
  }

  async rerank(
    query: string,
    results: SearchResult[],
    topN: number,
  ): Promise<SearchResult[]> {
    if (results.length === 0) return [];

    const heuristicRanked = results
      .map((result) => ({
        result,
        heuristicScore: this.computeHeuristicScore(query, result),
      }))
      .sort((a, b) => b.heuristicScore - a.heuristicScore);

    const llmWindowSize = Math.min(Math.max(topN * 2, 6), heuristicRanked.length);
    const llmCandidates = heuristicRanked.slice(0, llmWindowSize);

    if (!process.env.OPENAI_API_KEY) {
      return heuristicRanked
        .slice(0, topN)
        .map(({ result, heuristicScore }) => ({ ...result, rerankScore: heuristicScore }));
    }

    logger.debug(
      { before: results.length, llmWindowSize, topN },
      "开始混合 Rerank",
    );

    const concurrency = 4;
    const scored: (SearchResult & { rerankScore: number })[] = [];

    for (let i = 0; i < llmCandidates.length; i += concurrency) {
      const batch = llmCandidates.slice(i, i + concurrency);
      const batchScores = await Promise.all(
        batch.map(async ({ result, heuristicScore }) => {
          const llmScore = await this.scoreRelevance(query, result.fullContent || result.snippet);
          const fusedScore = heuristicScore * 0.45 + llmScore * 0.55;
          return { ...result, rerankScore: fusedScore };
        }),
      );
      scored.push(...batchScores);
    }

    const remaining = heuristicRanked.slice(llmWindowSize).map(({ result, heuristicScore }) => ({
      ...result,
      rerankScore: heuristicScore,
    }));

    const reranked = [...scored, ...remaining]
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topN);

    logger.debug(
      {
        before: results.length,
        after: reranked.length,
        llmScored: scored.length,
        topScore: reranked[0]?.rerankScore,
        minScore: reranked[reranked.length - 1]?.rerankScore,
      },
      "混合 Rerank 完成",
    );

    return reranked;
  }

  private computeHeuristicScore(query: string, result: SearchResult): number {
    const content = result.fullContent || result.snippet;
    const normalizedQuery = normalizeText(query);
    const normalizedContent = normalizeText(content);
    const overlap = lexicalOverlap(normalizedQuery, normalizedContent);
    const semanticScore = result.rrfScore ?? result.similarity ?? 0;
    const sourceBoost = result.source === "dense" ? 0.03 : result.source === "bm25" ? 0.02 : 0;

    return Math.max(0, Math.min(1, semanticScore * 0.65 + overlap * 0.3 + sourceBoost));
  }

  private async scoreRelevance(query: string, content: string): Promise<number> {
    try {
      const response = await this.openai.chat.completions.create({
        model: config.chat.model,
        messages: [
          {
            role: "user",
            content: RERANK_PROMPT.replace("{query}", query).replace(
              "{content}",
              content.slice(0, 1500),
            ),
          },
        ],
        max_tokens: 3,
        temperature: 0,
      });
      const text = response.choices[0]?.message?.content?.trim() || "5";
      const score = parseInt(text, 10);
      return Number.isNaN(score) ? 0.5 : Math.max(1, Math.min(10, score)) / 10;
    } catch (err) {
      logger.warn({ err }, "Rerank 打分失败，回退启发式分数");
      return 0.5;
    }
  }
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，,。；;！!？?、:"“”'‘’（）()【】\[\]{}《》<>/\\|\-]+/g, " ")
    .trim();
}

function lexicalOverlap(query: string, content: string): number {
  if (!query || !content) return 0;

  const queryTerms = tokenize(query);
  const contentTerms = tokenize(content);
  if (queryTerms.size === 0 || contentTerms.size === 0) return 0;

  let matched = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) {
      matched++;
    }
  }

  return matched / queryTerms.size;
}

function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  const compact = text.replace(/\s+/g, "");

  text.split(/\s+/).filter(Boolean).forEach((term) => {
    if (term.length >= 2) terms.add(term);
  });

  for (let i = 0; i < compact.length - 1; i++) {
    terms.add(compact.slice(i, i + 2));
  }

  return terms;
}
