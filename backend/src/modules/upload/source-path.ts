export interface SourcePathCandidate {
  documentId?: string;
  sourcePath?: string;
}

export function resolveDocumentSourcePath(
  documentId: string,
  task: { sourcePath?: string } | undefined,
  entries: SourcePathCandidate[],
): string | null {
  if (task?.sourcePath) return task.sourcePath;
  return entries.find((entry) => entry.documentId === documentId)?.sourcePath ?? null;
}
