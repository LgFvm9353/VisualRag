import type { KnowledgeBaseDocument } from "@/lib/knowledgeBaseApi";

interface KnowledgeBaseDocumentListProps {
  documents: KnowledgeBaseDocument[];
}

export function KnowledgeBaseDocumentList({
  documents,
}: KnowledgeBaseDocumentListProps) {
  return (
    <aside className="h-fit rounded-2xl border bg-white p-5 shadow-sm">
      <h2 className="font-semibold">知识库文档 ({documents.length})</h2>
      <div className="mt-4 space-y-2">
        {documents.map((document) => (
          <div key={document.id} className="rounded-xl border p-3">
            <p className="truncate text-sm font-medium">{document.fileName}</p>
            <p className="mt-1 text-xs uppercase text-slate-400">
              {document.fileType}
            </p>
          </div>
        ))}
      </div>
    </aside>
  );
}
