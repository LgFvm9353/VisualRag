import type { DocumentBlockKind } from "../../../document-parsing/types.js";
import { recursiveChunk, type ChunkResult } from "./strategies/recursive-chunker.js";

export interface StructuralBlockInput {
  kind: DocumentBlockKind;
  text: string;
}

export interface StructuralChunk extends ChunkResult {
  kind: DocumentBlockKind;
}

export function buildStructuralChunks(
  blocks: StructuralBlockInput[],
  options: { chunkSize: number; chunkOverlap: number },
): StructuralChunk[] {
  const chunks: StructuralChunk[] = [];
  let baseOffset = 0;
  for (const block of blocks) {
    const text = block.text;
    if (!text.trim()) continue;
    const results = recursiveChunk(text, baseOffset, options);
    chunks.push(...results.map((chunk) => ({ ...chunk, kind: block.kind })));
    baseOffset += text.length + 1;
  }
  return chunks;
}

export function mapParentChildIndexes(
  chunks: { sectionId: string; startOffset: number; endOffset: number }[],
  parent: { sectionId: string; startOffset: number; endOffset: number },
): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (
      chunk.sectionId === parent.sectionId &&
      chunk.startOffset >= parent.startOffset &&
      chunk.endOffset <= parent.endOffset
    ) {
      indexes.push(index);
    }
  }
  return indexes;
}

export function propagateSectionContexts(
  chunks: { sectionId: string }[],
  sampledResults: Map<number, string>,
): (string | null)[] {
  const lastBySection = new Map<string, string>();
  return chunks.map((chunk, index) => {
    const sampled = sampledResults.get(index);
    if (sampled) lastBySection.set(chunk.sectionId, sampled);
    return lastBySection.get(chunk.sectionId) ?? null;
  });
}
