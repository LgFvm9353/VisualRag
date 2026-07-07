/**
 * 递归分块器（2026 FloTorch 基准测试最佳策略）。
 *
 * 按分隔符优先级递归切分：
 *   \n\n → \n → 。→ ，→ 空格 → 字符
 *
 * 参数（基于 2026 基准结论）:
 *   chunkSize = 512 tokens (~1024 中文字符)
 *   chunkOverlap = 64 tokens (~128 中文字符, 10%)
 *   minChunkSize = 128 tokens
 */

export interface ChunkOptions {
  /** 目标 chunk 大小（token 数），默认 512 */
  chunkSize?: number;
  /** chunk 重叠大小（token 数），默认 64 */
  chunkOverlap?: number;
  /** 最小 chunk 大小（token 数），低于此值合并到前一个 chunk，默认 64 */
  minChunkSize?: number;
  /** 自定义分隔符（按优先级降序），不传则用中文优化默认值 */
  separators?: string[];
}

export interface ChunkResult {
  content: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
}

const DEFAULT_SEPARATORS = [
  "\n\n",
  "\n",
  "。",
  "；",
  "，",
  " ",
  "",
];

/** 中文场景：粗略估算 1 token ≈ 2 字符 */
function estimateTokens(text: string): number {
  // 中文字符约 2 字符/token，英文约 4 字符/token
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.8 + otherChars / 3.5);
}

function splitBySeparator(text: string, separator: string): string[] {
  if (separator === "") return text.split("");
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + separator.length) === separator) {
      parts.push(current + separator);
      current = "";
      i += separator.length - 1;
    } else {
      current += text[i];
    }
  }
  if (current) parts.push(current);
  return parts;
}

function mergeSplits(
  splits: string[],
  separator: string,
  chunkSize: number,
  chunkOverlap: number,
  minChunkSize: number,
  baseOffset: number,
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  const chunkCharSize = chunkSize * 2; // token → 字符估算
  const overlapCharSize = chunkOverlap * 2;
  const minCharSize = minChunkSize * 2;

  let currentChunk = "";
  let currentStart = 0;
  let offset = baseOffset;

  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    const splitLen = split.length;

    if (currentChunk.length + splitLen > chunkCharSize && currentChunk.length > 0) {
      // 当前 chunk 已满，保存
      const endOffset = offset;
      chunks.push({
        content: currentChunk,
        startOffset: currentStart,
        endOffset,
        tokenCount: estimateTokens(currentChunk),
      });

      // 计算 overlap: 从当前 chunk 末尾往回取 overlap 大小
      if (chunkOverlap > 0) {
        const overlapText = currentChunk.slice(-overlapCharSize);
        currentChunk = overlapText;
        currentStart = endOffset - overlapText.length;
      } else {
        currentChunk = "";
        currentStart = offset;
      }
    }

    currentChunk += split;
    offset += splitLen;
  }

  // 最后一个 chunk
  if (currentChunk.trim().length > 0) {
    const endOffset = offset;
    if (currentChunk.length < minCharSize && chunks.length > 0) {
      // 太小，合并到前一个
      const prev = chunks[chunks.length - 1];
      prev.content += currentChunk;
      prev.endOffset = endOffset;
      prev.tokenCount = estimateTokens(prev.content);
    } else {
      chunks.push({
        content: currentChunk,
        startOffset: currentStart,
        endOffset,
        tokenCount: estimateTokens(currentChunk),
      });
    }
  }

  return chunks;
}

/**
 * 递归分块主函数。
 * @param text 输入文本
 * @param baseOffset 在原始文本中的起始偏移（跨页使用）
 * @param options 分块参数
 */
export function recursiveChunk(
  text: string,
  baseOffset = 0,
  options: ChunkOptions = {},
): ChunkResult[] {
  const {
    chunkSize = 512,
    chunkOverlap = 64,
    minChunkSize = 64,
    separators = DEFAULT_SEPARATORS,
  } = options;

  if (estimateTokens(text) <= chunkSize) {
    // 文本本身就在 chunk 大小以内
    return [
      {
        content: text,
        startOffset: baseOffset,
        endOffset: baseOffset + text.length,
        tokenCount: estimateTokens(text),
      },
    ];
  }

  // 逐级尝试分隔符
  for (const separator of separators) {
    const splits = splitBySeparator(text, separator);
    if (splits.length > 1 || separator === "") {
      const chunks = mergeSplits(
        splits,
        separator,
        chunkSize,
        chunkOverlap,
        minChunkSize,
        baseOffset,
      );
      if (chunks.length > 1 || separator === "") {
        return chunks;
      }
    }
  }

  // 最终兜底：整段返回
  return [
    {
      content: text,
      startOffset: baseOffset,
      endOffset: baseOffset + text.length,
      tokenCount: estimateTokens(text),
    },
  ];
}

export { estimateTokens };
