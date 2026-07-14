'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { CitationPreviewPanel } from "@/components/CitationPreviewPanel";
import {
  KnowledgeBaseChat,
  type ChatMessage,
} from "@/components/KnowledgeBaseChat";
import { KnowledgeBaseDocumentList } from "@/components/KnowledgeBaseDocumentList";
import {
  createAgentSession,
  listKnowledgeBaseDocuments,
  streamAgentMessage,
  uploadKnowledgeBaseDocument,
  type KnowledgeBaseCitation,
  type KnowledgeBaseDocument,
} from "@/lib/knowledgeBaseApi";

export default function HomePage() {
  const [documents, setDocuments] = useState<KnowledgeBaseDocument[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [citation, setCitation] = useState<KnowledgeBaseCitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listKnowledgeBaseDocuments());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "knowledge_base_load_failed",
      );
    }
  }, []);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;

    const session = await createAgentSession();
    setSessionId(session.id);
    return session.id;
  }

  async function handleAsk() {
    const value = query.trim();
    if (!value || loading) return;

    setQuery("");
    setLoading(true);
    setError(null);

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((items) => [
      ...items,
      { id: userId, role: "user", content: value },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        status: "正在理解问题…",
        trace: [],
      },
    ]);

    try {
      const id = await ensureSession();
      await streamAgentMessage(id, value, (event) => {
        setMessages((items) =>
          items.map((message) => {
            if (message.id !== assistantId) return message;

            const trace = [
              ...(message.trace ?? []),
              { type: event.type, data: event.data },
            ];
            if (event.type === "answer.delta") {
              return {
                ...message,
                content: message.content + String(event.data.delta ?? ""),
                status: "正在组织回答…",
                trace,
              };
            }
            if (event.type === "intent.completed") {
              return { ...message, status: "正在检索知识库…", trace };
            }
            if (event.type === "evidence.completed") {
              return { ...message, status: "正在核验证据…", trace };
            }
            if (event.type === "citations.completed") {
              return {
                ...message,
                citations: event.data.citations as KnowledgeBaseCitation[],
                trace,
              };
            }
            if (event.type === "message.completed") {
              const completed = event.data.message as { content?: string };
              return {
                ...message,
                status: "completed",
                content: message.content || String(completed?.content ?? ""),
                trace,
              };
            }
            if (event.type === "message.failed") {
              return {
                ...message,
                status: "failed",
                content: String(event.data.message ?? "Agent 执行失败"),
                trace,
              };
            }
            return { ...message, trace };
          }),
        );
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "agent_request_failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      await uploadKnowledgeBaseDocument(file);
      await refreshDocuments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "upload_failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.docx,.pptx,.txt,.md,.html,.htm"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleUpload(file);
        }}
      />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
          <div>
            <h1 className="text-xl font-bold">VisualRAG 知识库 Agent</h1>
            <p className="mt-1 text-sm text-slate-500">
              支持多轮追问，只在证据充分时回答。
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm text-white disabled:opacity-50"
          >
            {uploading ? "导入中…" : "导入文档"}
          </button>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="space-y-4">
          <div className="min-h-80 space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
            <KnowledgeBaseChat
              messages={messages}
              onOpenCitation={setCitation}
            />
          </div>
          {error ? (
            <div className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="向整个知识库提问…"
              className="min-h-24 w-full resize-y rounded-xl border p-3"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  void handleAsk();
                }
              }}
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => void handleAsk()}
                disabled={loading || !query.trim()}
                className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm text-white disabled:opacity-40"
              >
                {loading ? "Agent 处理中…" : "发送"}
              </button>
            </div>
          </div>
        </section>
        <KnowledgeBaseDocumentList documents={documents} />
      </div>
      <CitationPreviewPanel
        citation={citation}
        onClose={() => setCitation(null)}
      />
    </main>
  );
}
