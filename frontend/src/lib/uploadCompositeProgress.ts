export type CompositeProgressPhase = "hashing" | "uploading" | "processing";

const progressRanges: Record<
  CompositeProgressPhase,
  { start: number; span: number }
> = {
  hashing: { start: 0, span: 5 },
  uploading: { start: 5, span: 55 },
  processing: { start: 60, span: 40 },
};

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

export function mapCompositeProgress(
  phase: CompositeProgressPhase,
  localProgress: number,
): number {
  const range = progressRanges[phase];
  return range.start + (clampProgress(localProgress) / 100) * range.span;
}

export function keepProgressMonotonic(previous: number, next: number): number {
  return Math.max(previous, next);
}
