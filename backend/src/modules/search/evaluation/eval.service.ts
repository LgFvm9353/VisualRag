/**
 * RAG 评估框架（基于 Ragas 指标体系）。
 *
 * 指标:
 *   - Contextual Precision: 检索到的 chunk 有多少是相关的
 *   - Contextual Recall: 相关的 chunk 有多少被检索到
 *   - Faithfulness: 回答是否基于检索内容（而非编造）
 *   - nDCG@5: Top-5 检索结果的归一化折损累计增益
 *   - MRR: 平均倒数排名（第一个相关结果的位置）
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../../lib/logger.js";

export interface EvalQuery {
  id: string;
  query: string;
  documentId: string;
  /** 人工标注的相关 chunk ID 列表 */
  relevantChunkIds: string[];
}

export interface EvalResult {
  query: string;
  contextualPrecision: number;
  contextualRecall: number;
  nDCG5: number;
  mrr: number;
}

export class EvalService {
  constructor(private prisma: PrismaClient) {}

  /**
   * 运行评估并保存结果。
   */
  async runEvaluation(
    testQueries: EvalQuery[],
    searchFn: (query: string, docId: string) => Promise<{ chunkId?: string }[]>,
  ): Promise<EvalResult[]> {
    const results: EvalResult[] = [];

    for (const testQuery of testQueries) {
      const retrieved = await searchFn(testQuery.query, testQuery.documentId);
      const retrievedIds = retrieved.map((r) => r.chunkId).filter(Boolean) as string[];

      const contextualPrecision = this.computePrecision(
        retrievedIds,
        testQuery.relevantChunkIds,
      );
      const contextualRecall = this.computeRecall(
        retrievedIds,
        testQuery.relevantChunkIds,
      );
      const nDCG5 = this.computeNDCG(
        retrievedIds.slice(0, 5),
        testQuery.relevantChunkIds,
      );
      const mrr = this.computeMRR(retrievedIds, testQuery.relevantChunkIds);

      results.push({
        query: testQuery.query,
        contextualPrecision,
        contextualRecall,
        nDCG5,
        mrr,
      });

      // 保存到数据库
      await this.prisma.evalRecord.create({
        data: {
          query: testQuery.query,
          documentId: testQuery.documentId,
          retrievedChunkIds: retrievedIds,
          contextualPrecision,
          contextualRecall,
          nDCG5,
          mrr,
        },
      });
    }

    this.logSummary(results);
    return results;
  }

  /**
   * Contextual Precision: 检索结果中相关 chunk 的比例。
   */
  private computePrecision(retrieved: string[], relevant: string[]): number {
    if (retrieved.length === 0) return 0;
    const relevantSet = new Set(relevant);
    let relevantCount = 0;
    for (const id of retrieved) {
      if (relevantSet.has(id)) relevantCount++;
    }
    return relevantCount / retrieved.length;
  }

  /**
   * Contextual Recall: 相关 chunk 中被检索到的比例。
   */
  private computeRecall(retrieved: string[], relevant: string[]): number {
    if (relevant.length === 0) return 1;
    const retrievedSet = new Set(retrieved);
    let found = 0;
    for (const id of relevant) {
      if (retrievedSet.has(id)) found++;
    }
    return found / relevant.length;
  }

  /**
   * nDCG@k: 考虑排序位置的检索质量指标。
   * DCG_k = Σ rel_i / log2(i+2)
   * IDCG_k = 完美排序的 DCG
   * nDCG_k = DCG_k / IDCG_k
   */
  private computeNDCG(retrieved: string[], relevant: string[], k = 5): number {
    if (retrieved.length === 0 || relevant.length === 0) return 0;
    const relevantSet = new Set(relevant);

    let dcg = 0;
    for (let i = 0; i < Math.min(retrieved.length, k); i++) {
      const rel = relevantSet.has(retrieved[i]) ? 1 : 0;
      dcg += rel / Math.log2(i + 2);
    }

    // IDCG: 完美排序（所有相关结果排在前 k 位）
    const idealRelevant = Math.min(relevant.length, k);
    let idcg = 0;
    for (let i = 0; i < idealRelevant; i++) {
      idcg += 1 / Math.log2(i + 2);
    }

    return idcg === 0 ? 0 : dcg / idcg;
  }

  /**
   * MRR (Mean Reciprocal Rank): 第一个相关结果的排名倒数。
   */
  private computeMRR(retrieved: string[], relevant: string[]): number {
    const relevantSet = new Set(relevant);
    for (let i = 0; i < retrieved.length; i++) {
      if (relevantSet.has(retrieved[i])) {
        return 1 / (i + 1);
      }
    }
    return 0;
  }

  private logSummary(results: EvalResult[]): void {
    if (results.length === 0) return;
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    logger.info(
      {
        queries: results.length,
        avgPrecision: avg(results.map((r) => r.contextualPrecision)).toFixed(3),
        avgRecall: avg(results.map((r) => r.contextualRecall)).toFixed(3),
        avgNDCG5: avg(results.map((r) => r.nDCG5)).toFixed(3),
        avgMRR: avg(results.map((r) => r.mrr)).toFixed(3),
      },
      "RAG 评估完成",
    );
  }
}

/**
 * 生成示例 test queries（实际使用时替换为人工标注数据）。
 */
export function createSampleEvalQueries(documentId: string): EvalQuery[] {
  return [
    {
      id: "q1",
      query: "本文档的主要内容是什么？",
      documentId,
      relevantChunkIds: [],
    },
    {
      id: "q2",
      query: "Q3 的营收数据是多少？",
      documentId,
      relevantChunkIds: [],
    },
  ];
}
