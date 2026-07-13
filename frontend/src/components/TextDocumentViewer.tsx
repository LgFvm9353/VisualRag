"use client";

import type { FC } from "react";
import { useEffect, useRef } from "react";
import { usePdfViewerStore } from "@/store/pdfViewerStore";

export interface TextDocumentSection {
  index: number;
  title?: string | null;
  content: string;
}

interface TextDocumentViewerProps {
  documentId: string;
  sections: TextDocumentSection[];
}

export const TextDocumentViewer: FC<TextDocumentViewerProps> = ({ documentId, sections }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeReference = usePdfViewerStore((s) => s.activeReference);
  const setCurrentPage = usePdfViewerStore((s) => s.setCurrentPage);

  useEffect(() => {
    if (!activeReference) return;
    if (activeReference.documentId !== documentId) return;
    const targetIndex = activeReference.sectionIndex ?? activeReference.pageNumber;
    const target = containerRef.current?.querySelector(`[data-section-index="${targetIndex}"]`) as HTMLElement | null;
    if (!target) return;
    setCurrentPage(targetIndex);
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [activeReference, documentId, setCurrentPage]);

  return (
    <div ref={containerRef} className="h-full w-full overflow-y-auto px-8 py-10">
      <div className="mx-auto max-w-4xl space-y-4">
        {sections.map((section) => (
          <article
            key={section.index}
            data-section-index={section.index}
            className="rounded-2xl border border-slate-200 bg-white px-5 py-4"
          >
            <div className="mb-2 text-xs text-slate-400">段落 {section.index}</div>
            {section.title ? <h3 className="mb-2 text-base font-semibold text-slate-900">{section.title}</h3> : null}
            <div className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{section.content}</div>
          </article>
        ))}
      </div>
    </div>
  );
};
