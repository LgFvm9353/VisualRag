/**
 * Reranker 服务 — 2026 单项 ROI 最高的检索优化。
 *
 * 当前实现: LLM-based rerank（让 LLM 对每个 chunk 做 1-10 相关性打分）。
 * 后续可替换为: bge-reranker / Cohere Rerank API。
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

  /**
   * 对检索结果进行 LLM 重排。
   * 批量打分后按 rerankScore 降序排列，取 topN。
   */
  async rerank(
    query: string,
    results: SearchResult[],
    topN: number,
  ): Promise<SearchResult[]> {
    if (results.length === 0) return [];
    if (results.length <= topN) return results;

    logger.debug({ count: results.length }, "开始 LLM Rerank");

    // 并发打分（限制并发数）
    const concurrency = 5;
    const scored: (SearchResult & { rerankScore: number })[] = [];

    for (let i = 0; i < results.length; i += concurrency) {
      const batch = results.slice(i, i + concurrency);
      const batchScores = await Promise.all(
        batch.map(async (result) => {
          const score = await this.scoreRelevance(query, result.fullContent || result.snippet);
          return { ...result, rerankScore: score };
        }),
      );
      scored.push(...batchScores);
    }

    const reranked = scored
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topN);

    logger.debug(
      {
        before: results.length,
        after: reranked.length,
        topScore: reranked[0]?.rerankScore,
        minScore: reranked[reranked.length - 1]?.rerankScore,
      },
      "Rerank 完成",
    );

    return reranked;
  }

  /**
   * 对单个 chunk 打分。
   */
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
      return Number.isNaN(score) ? 5 : Math.max(1, Math.min(10, score)) / 10; // 归一化到 0.1-1.0
    } catch (err) {
      logger.warn({ err }, "Rerank 打分失败");
      return 0.5;
    }
  }
}
