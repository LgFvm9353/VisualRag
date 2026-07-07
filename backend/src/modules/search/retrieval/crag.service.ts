/**
 * CRAG (Corrective RAG) 检索自评服务。
 *
 * 替代 Multi-Query 的 2026 更优方案：
 *   LLM 评估检索结果质量 → 决定是否需要重新检索/补充检索。
 */

import OpenAI from "openai";
import { config } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import type { SearchResult } from "./post-processor.js";

export type CragDecision =
  | { action: "accept"; reason: string }
  | { action: "refine"; reason: string; refinedQuery: string }
  | { action: "reject"; reason: string; newQuery: string };

const CRAG_PROMPT = `你是一个检索质量评估助手。评估以下检索结果能否回答用户的问题。

用户问题: {query}

检索到的文档片段（共 {count} 条）:
{results}

请判断:
1. 这些片段是否包含回答问题所需的关键信息？
2. 如果信息不足，缺少什么？
3. 需要如何改进检索？

请用以下 JSON 格式回答:
{
  "action": "accept|refine|reject",
  "reason": "判断理由（中文，简洁）",
  "suggestion": "如果是 refine 或 reject，给出改进的检索查询"
}

规则:
- accept: 检索结果包含了回答问题的完整信息
- refine: 检索结果部分相关，但可以用更精确的查询补充检索
- reject: 检索结果完全不相关，需要用全新的查询重新检索`;

export class CragService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: config.chat.baseURL,
      apiKey: config.chat.apiKey,
    });
  }

  /**
   * 评估检索结果质量，返回决策。
   */
  async evaluate(
    query: string,
    results: SearchResult[],
  ): Promise<CragDecision> {
    if (results.length === 0) {
      return {
        action: "reject",
        reason: "检索结果为空",
        newQuery: query,
      };
    }

    try {
      const resultsText = results
        .slice(0, 10)
        .map(
          (r, i) =>
            `[${i + 1}] (相似度: ${(r.rerankScore ?? r.similarity ?? 0).toFixed(2)})\n${(r.fullContent || r.snippet).slice(0, 300)}`,
        )
        .join("\n\n---\n\n");

      const response = await this.openai.chat.completions.create({
        model: config.chat.model,
        messages: [
          {
            role: "user",
            content: CRAG_PROMPT.replace("{query}", query)
              .replace("{count}", String(results.length))
              .replace("{results}", resultsText),
          },
        ],
        max_tokens: 200,
        temperature: 0,
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);

      const action = parsed.action || "accept";
      const reason = parsed.reason || "";
      const suggestion = parsed.suggestion || query;

      switch (action) {
        case "refine":
          return { action: "refine", reason, refinedQuery: suggestion };
        case "reject":
          return { action: "reject", reason, newQuery: suggestion };
        default:
          return { action: "accept", reason };
      }
    } catch (err) {
      logger.warn({ err }, "CRAG 评估失败，默认接受");
      return { action: "accept", reason: "评估失败，跳过自评" };
    }
  }
}
