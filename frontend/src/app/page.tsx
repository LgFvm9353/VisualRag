'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { CitationPreviewPanel } from "@/components/CitationPreviewPanel";
import { KnowledgeBaseAnswer } from "@/components/KnowledgeBaseAnswer";
import {
  askKnowledgeBase,
  listKnowledgeBaseDocuments,
  uploadKnowledgeBaseDocument,
  type AskKnowledgeBaseResponse,
  type KnowledgeBaseCitation,
  type KnowledgeBaseDocument,
} from "@/lib/knowledgeBaseApi";

export default function HomePage() {
  const [documents, setDocuments] = useState<KnowledgeBaseDocument[]>([]);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AskKnowledgeBaseResponse | null>(null);
  const [citation, setCitation] = useState<KnowledgeBaseCitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listKnowledgeBaseDocuments());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "knowledge_base_load_failed");
    }
  }, []);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  async function handleAsk() {
    const value = query.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await askKnowledgeBase({ query: value }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "knowledge_base_ask_failed");
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
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5">
          <div>
            <h1 className="text-xl font-bold">VisualRAG 企业知识库</h1>
            <p className="mt-1 text-sm text-slate-500">默认检索整个知识库，只在证据充分时回答。</p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {uploading ? "导入中…" : "导入文档"}
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <label htmlFor="knowledge-query" className="text-sm font-semibold">向整个知识库提问</label>
            <textarea
              id="knowledge-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：公司的差旅报销规则是什么？请给出引用依据。"
              className="mt-3 min-h-32 w-full resize-y rounded-xl border border-slate-200 p-3 outline-none focus:border-indigo-500"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void handleAsk();
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-slate-400">Ctrl / Cmd + Enter 发送</span>
              <button
                type="button"
                onClick={() => void handleAsk()}
                disabled={loading || !query.trim() || documents.length === 0}
                className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {loading ? "检索与核验中…" : "查询知识库"}
              </button>
            </div>
          </div>

          {error ? <div className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
          {result ? <KnowledgeBaseAnswer result={result} onOpenCitation={setCitation} /> : (
            <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
              回答会显示在这里；证据不足时系统会明确拒答。
            </div>
          )}
        </section>

        <aside className="h-fit rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">知识库文档</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{documents.length}</span>
          </div>
          <div className="mt-4 space-y-2">
            {documents.length === 0 ? <p className="text-sm text-slate-500">尚无已完成建库的文档。</p> : documents.map((document) => (
              <div key={document.id} className="rounded-xl border border-slate-200 p-3">
                <p className="truncate text-sm font-medium">{document.fileName}</p>
                <p className="mt-1 text-xs uppercase text-slate-400">{document.fileType}</p>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <CitationPreviewPanel citation={citation} onClose={() => setCitation(null)} />
    </main>
  );
}
