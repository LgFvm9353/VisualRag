'use client';

import type { AskKnowledgeBaseResponse, KnowledgeBaseCitation } from "@/lib/knowledgeBaseApi";

interface KnowledgeBaseAnswerProps {
  result: AskKnowledgeBaseResponse;
  onOpenCitation: (citation: KnowledgeBaseCitation) => void;
}

export function KnowledgeBaseAnswer({ result, onOpenCitation }: KnowledgeBaseAnswerProps) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-900">知识库回答</h2>
        <span className={`rounded-full px-3 py-1 text-xs ${result.decision === "answer" ? "bg-emerald-50 text-emerald-700" : result.decision === "narrow" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
          {result.decision === "answer" ? "证据充分" : result.decision === "narrow" ? "证据有限" : "已拒答"}
        </span>
      </div>
      <p className="whitespace-pre-wrap leading-7 text-slate-700">{result.answer}</p>
      {result.decision !== "answer" ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">建议缩小问题范围或补充关键词。</p>
      ) : null}
      {result.citations.length > 0 ? (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">引用来源</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {result.citations.map((citation, index) => (
              <button
                key={`${citation.documentId}-${citation.chunkId ?? index}`}
                type="button"
                onClick={() => onOpenCitation(citation)}
                className="rounded-xl border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50"
              >
                <div className="text-sm font-medium text-slate-800">{citation.fileName}</div>
                <div className="mt-1 text-xs text-slate-500">第 {citation.pageNumber} 处</div>
                <p className="mt-2 line-clamp-3 text-sm text-slate-600">{citation.snippet}</p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="mt-4 text-xs text-slate-400">检索 {result.retrieval.hitCount} 条证据 · {result.trace.durationMs} ms</p>
    </article>
  );
}
