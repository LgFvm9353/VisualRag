export type KnowledgeBaseSourceType = "pdf" | "docx" | "pptx" | "text" | "html";

export interface KnowledgeBaseCitation {
  documentId: string;
  fileName: string;
  pageNumber: number;
  chunkId?: string;
  snippet: string;
  sourceType: KnowledgeBaseSourceType;
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

export type IngestionStage =
  | "queued"
  | "extracting_text"
  | "layout_analysis"
  | "generating_text_embeddings"
  | "generating_image_embeddings"
  | "writing_database"
  | "completed"
  | "failed";

export interface IngestionTask {
  id: string;
  fileName: string;
  stage: IngestionStage;
  progress: number;
  error?: string;
}

export interface UploadProgress {
  phase: "hashing" | "uploading";
  progress: number;
}

export interface UploadResult {
  taskId: string;
  documentId?: string;
  deduplicated: boolean;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
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

export async function listKnowledgeBaseDocuments(): Promise<KnowledgeBaseDocument[]> {
  const response = await fetch(`${backendUrl}/knowledge-base/documents`);
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { documents: KnowledgeBaseDocument[] };
  return body.documents;
}

export async function uploadKnowledgeBaseDocument(
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { onProgress, signal } = options;
  onProgress?.({ phase: "hashing", progress: 0 });
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hash = [...new Uint8Array(hashBuffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  onProgress?.({ phase: "hashing", progress: 100 });

  const chunkSize = 5 * 1024 * 1024;
  const initResponse = await fetch(`${backendUrl}/upload/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, hash, chunkSize }),
    signal,
  });
  if (!initResponse.ok) throw new Error(await readError(initResponse));
  const init = await initResponse.json() as
    | { fast: true; taskId: string; documentId?: string }
    | { fast: false; uploadId: string; uploadedChunks: number[]; totalChunks: number; chunkSize: number };
  if (init.fast) {
    onProgress?.({ phase: "uploading", progress: 100 });
    return {
      taskId: init.taskId,
      documentId: init.documentId,
      deduplicated: true,
    };
  }

  const uploaded = new Set(init.uploadedChunks);
  const reportUploadProgress = () => {
    onProgress?.({
      phase: "uploading",
      progress: Math.round((uploaded.size / init.totalChunks) * 100),
    });
  };
  reportUploadProgress();
  for (let index = 0; index < init.totalChunks; index += 1) {
    if (uploaded.has(index)) continue;
    const start = index * init.chunkSize;
    const response = await fetch(
      `${backendUrl}/upload/chunk?uploadId=${encodeURIComponent(init.uploadId)}&index=${index}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file.slice(start, Math.min(file.size, start + init.chunkSize)),
        signal,
      },
    );
    if (!response.ok) throw new Error(await readError(response));
    uploaded.add(index);
    reportUploadProgress();
  }

  const completeResponse = await fetch(`${backendUrl}/upload/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId }),
    signal,
  });
  if (!completeResponse.ok) throw new Error(await readError(completeResponse));
  const result = await completeResponse.json() as {
    taskId: string;
    documentId?: string;
    dedup?: boolean;
  };
  return {
    taskId: result.taskId,
    documentId: result.documentId,
    deduplicated: result.dedup === true,
  };
}

export async function getIngestionTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<IngestionTask> {
  const response = await fetch(`${backendUrl}/tasks/${taskId}`, { signal });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export type AgentStreamEvent = {
  type: string;
  eventId: string;
  sessionId: string;
  messageId: string;
  traceId: string;
  sequence: number;
  timestamp: string;
  data: Record<string, unknown>;
};

export interface AgentSession {
  id: string;
  documentId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createAgentSession(): Promise<AgentSession> {
  const response = await fetch(`${backendUrl}/agent/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function streamAgentMessage(
  sessionId: string,
  content: string,
  onEvent: (event: AgentStreamEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${backendUrl}/agent/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await readError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame || frame.startsWith(":")) continue;
      const lines = frame.split("\n");
      const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!type || !data) continue;
      const envelope = JSON.parse(data) as Omit<AgentStreamEvent, "type">;
      await onEvent({ type, ...envelope });
    }
    if (done) break;
  }
}

export { backendUrl };
