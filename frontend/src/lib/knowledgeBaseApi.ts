export type KnowledgeBaseDecision = "answer" | "refuse" | "narrow";
export type KnowledgeBaseSourceType = "pdf" | "docx" | "pptx" | "text" | "html";

export interface KnowledgeBaseCitation {
  documentId: string;
  fileName: string;
  pageNumber: number;
  chunkId?: string;
  snippet: string;
  sourceType: KnowledgeBaseSourceType;
}

export interface AskKnowledgeBaseResponse {
  answer: string;
  decision: KnowledgeBaseDecision;
  citations: KnowledgeBaseCitation[];
  retrieval: {
    hitCount: number;
    cragAction: "accept" | "refine" | "reject";
    refinedQuery: string | null;
    usedReranker: string;
  };
  trace: { traceId: string; durationMs: number; startedAt: string };
}

export interface KnowledgeBaseDocument {
  id: string;
  fileName: string;
  fileType: string;
  sourceLabel: string | null;
  publishedAt: string | null;
  tags: string[];
  createdAt: string;
}

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error || body.message || `request_failed_${response.status}`;
  } catch {
    return `request_failed_${response.status}`;
  }
}

export async function askKnowledgeBase(input: {
  query: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<AskKnowledgeBaseResponse> {
  const response = await fetch(`${backendUrl}/knowledge-base/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function listKnowledgeBaseDocuments(): Promise<KnowledgeBaseDocument[]> {
  const response = await fetch(`${backendUrl}/knowledge-base/documents`);
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { documents: KnowledgeBaseDocument[] };
  return body.documents;
}

export async function uploadKnowledgeBaseDocument(file: File): Promise<{ taskId: string }> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hash = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const chunkSize = 5 * 1024 * 1024;
  const initResponse = await fetch(`${backendUrl}/upload/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, hash, chunkSize }),
  });
  if (!initResponse.ok) throw new Error(await readError(initResponse));
  const init = await initResponse.json() as
    | { fast: true; taskId: string }
    | { fast: false; uploadId: string; uploadedChunks: number[]; totalChunks: number; chunkSize: number };
  if (init.fast) return { taskId: init.taskId };

  const uploaded = new Set(init.uploadedChunks);
  for (let index = 0; index < init.totalChunks; index += 1) {
    if (uploaded.has(index)) continue;
    const start = index * init.chunkSize;
    const response = await fetch(`${backendUrl}/upload/chunk?uploadId=${encodeURIComponent(init.uploadId)}&index=${index}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file.slice(start, Math.min(file.size, start + init.chunkSize)),
    });
    if (!response.ok) throw new Error(await readError(response));
  }

  const completeResponse = await fetch(`${backendUrl}/upload/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  if (!completeResponse.ok) throw new Error(await readError(completeResponse));
  return completeResponse.json();
}

export { backendUrl };
