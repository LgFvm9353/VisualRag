import type { KnowledgeBaseCitation } from "@/lib/knowledgeBaseApi";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: string;
  citations?: KnowledgeBaseCitation[];
  trace?: Array<{ type: string; data: Record<string, unknown> }>;
}

interface KnowledgeBaseChatProps {
  messages: ChatMessage[];
  onOpenCitation: (citation: KnowledgeBaseCitation) => void;
}

export function KnowledgeBaseChat({
  messages,
  onOpenCitation,
}: KnowledgeBaseChatProps) {
  if (messages.length === 0) {
    return (
      <p className="py-20 text-center text-sm text-slate-500">
        向知识库 Agent 提问，可以继续追问上下文。
      </p>
    );
  }

  return messages.map((message) => (
    <article
      key={message.id}
      className={
        message.role === "user"
          ? "ml-auto max-w-2xl rounded-2xl bg-slate-900 p-4 text-white"
          : "mr-auto max-w-3xl rounded-2xl bg-slate-100 p-4"
      }
    >
      <p className="whitespace-pre-wrap text-sm">
        {message.content || message.status}
      </p>
      {message.citations?.map((citation) => (
        <button
          key={`${citation.documentId}-${citation.chunkId}`}
          type="button"
          onClick={() => onOpenCitation(citation)}
          className="mt-3 block text-left text-xs text-indigo-600"
        >
          {citation.fileName} · 第 {citation.pageNumber} 页
        </button>
      ))}
      {message.trace?.length ? (
        <details className="mt-3 text-xs text-slate-500">
          <summary>查看检索过程</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(message.trace, null, 2)}
          </pre>
        </details>
      ) : null}
    </article>
  ));
}
