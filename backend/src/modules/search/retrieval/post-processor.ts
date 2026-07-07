/**
 * 检索后处理器。
 *
 * 功能:
 *   - MMR 多样性重排（避免返回重复内容的 chunk）
 *   - 相似度阈值过滤
 *   - 内容去重
 */

export interface SearchResult {
  documentId: string;
  pageNumber: number;
  snippet: string;
  fullContent?: string;
  chunkId?: string;
  parentContextId?: string;
  similarity?: number;
  rrfScore?: number;
  rerankScore?: number;
  source?: "dense" | "bm25" | "hybrid";
}

export interface PostProcessOptions {
  threshold?: number;
  deduplicate?: boolean;
}

/**
 * 后处理主入口。
 */
export function postProcess(
  results: SearchResult[],
  options: PostProcessOptions = {},
): SearchResult[] {
  let processed = results;

  // 1. 相似度阈值过滤
  if (options.threshold !== undefined && options.threshold > 0) {
    processed = processed.filter(
      (r) => (r.rerankScore ?? r.rrfScore ?? r.similarity ?? 0) >= options.threshold!,
    );
  }

  // 2. MMR 多样性
  processed = mmrDiversify(processed);

  // 3. 去重
  if (options.deduplicate) {
    processed = deduplicateByContent(processed);
  }

  return processed;
}

/**
 * MMR (Maximal Marginal Relevance) 多样性重排。
 *
 * 贪心选择: 每次从候选集中选一个"与 query 最相关"且"与已选结果最不相似"的结果。
 *
 * MMR = λ × relevance(d) - (1-λ) × max_similarity(d, selected)
 */
export function mmrDiversify(
  results: SearchResult[],
  lambda = 0.7,
  topN?: number,
): SearchResult[] {
  if (results.length <= 2) return results;

  const n = topN ?? results.length;
  const selected: SearchResult[] = [];
  const candidates = [...results];

  // 第一个选最相关的
  const first = candidates.shift()!;
  selected.push(first);

  while (selected.length < n && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const relevance = candidates[i].rerankScore ?? candidates[i].rrfScore ?? candidates[i].similarity ?? 0;
      // 与已选结果的最大相似度（基于 chunk 文本 Jaccard 近似）
      const maxSim = selected.reduce((max, s) => {
        const sim = jaccardSimilarity(
          candidates[i].fullContent || candidates[i].snippet,
          s.fullContent || s.snippet,
        );
        return Math.max(max, sim);
      }, 0);

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    selected.push(candidates[bestIdx]);
    candidates.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * 基于内容的去重。
 * 如果两个 chunk 的 Jaccard 相似度 > 0.8，只保留得分更高的那个。
 */
export function deduplicateByContent(results: SearchResult[]): SearchResult[] {
  const deduped: SearchResult[] = [];

  for (const r of results) {
    const isDuplicate = deduped.some((d) => {
      const sim = jaccardSimilarity(
        r.fullContent || r.snippet,
        d.fullContent || d.snippet,
      );
      return sim > 0.8;
    });

    if (!isDuplicate) {
      deduped.push(r);
    }
  }

  return deduped;
}

/**
 * 简单的 Jaccard 相似度（基于词级）。
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => {
    // 简单的大二元切分（bigram）
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.slice(i, i + 2));
    }
    return bigrams;
  };

  const setA = tokenize(a.slice(0, 1000));
  const setB = tokenize(b.slice(0, 1000));

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
