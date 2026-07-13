'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import { DocxViewer } from "@/components/DocxViewer";
import { PdfViewer, type PdfPageMetadata } from "@/components/PdfViewer";
import { TextDocumentViewer, type TextDocumentSection } from "@/components/TextDocumentViewer";
import { backendUrl, type KnowledgeBaseCitation } from "@/lib/knowledgeBaseApi";
import { usePdfViewerStore } from "@/store/pdfViewerStore";

interface CitationPreviewPanelProps {
  citation: KnowledgeBaseCitation | null;
  onClose: () => void;
}

type SourceDocument = { id: string; fileName: string; fileType: string; status: string };

export function CitationPreviewPanel({ citation, onClose }: CitationPreviewPanelProps) {
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [pages, setPages] = useState<PdfPageMetadata[]>([]);
  const [html, setHtml] = useState<string | null>(null);
  const [sections, setSections] = useState<TextDocumentSection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const setActiveReference = usePdfViewerStore((state) => state.setActiveReference);

  useEffect(() => {
    if (!citation) return;
    let cancelled = false;
    setSource(null);
    setPages([]);
    setHtml(null);
    setSections([]);
    setError(null);
    setActiveReference({ documentId: citation.documentId, pageNumber: citation.pageNumber, sectionIndex: citation.pageNumber });

    const load = async () => {
      try {
        const sourceResponse = await fetch(`${backendUrl}/documents/${citation.documentId}/source`);
        if (!sourceResponse.ok) throw new Error("source_not_found");
        const sourceDocument = await sourceResponse.json() as SourceDocument;
        if (cancelled) return;
        setSource(sourceDocument);

        if (sourceDocument.fileType === "pdf") {
          const regionsResponse = await fetch(`${backendUrl}/documents/${citation.documentId}/regions`);
          if (!regionsResponse.ok) throw new Error("regions_not_found");
          const regions = await regionsResponse.json() as { pages: PdfPageMetadata[] };
          setPages(regions.pages);
          GlobalWorkerOptions.workerSrc = GlobalWorkerOptions.workerSrc || "https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
          pdfRef.current = await getDocument(`${backendUrl}/files/${citation.documentId}`).promise;
          return;
        }

        if (sourceDocument.fileType === "docx") {
          const htmlResponse = await fetch(`${backendUrl}/documents/${citation.documentId}/html`);
          if (!htmlResponse.ok) throw new Error("html_not_found");
          setHtml(await htmlResponse.text());
          return;
        }

        const sectionsResponse = await fetch(`${backendUrl}/documents/${citation.documentId}/sections`);
        if (!sectionsResponse.ok) throw new Error("sections_not_found");
        const body = await sectionsResponse.json() as { sections: TextDocumentSection[] };
        setSections(body.sections);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "source_preview_failed");
      }
    };

    void load();
    return () => {
      cancelled = true;
      pdfRef.current?.destroy().catch(() => undefined);
      pdfRef.current = null;
    };
  }, [citation, setActiveReference]);

  const renderPdfPage = useCallback(async (page: PdfPageMetadata, canvasRef: { current: HTMLCanvasElement | null }) => {
    if (!pdfRef.current || !canvasRef.current) return;
    const pdfPage = await pdfRef.current.getPage(page.pageNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: page.width / baseViewport.width });
    const context = canvasRef.current.getContext("2d");
    if (!context) return;
    canvasRef.current.width = viewport.width;
    canvasRef.current.height = viewport.height;
    await pdfPage.render({ canvasContext: context, viewport } as never).promise;
  }, []);

  if (!citation) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/30 p-4" onClick={onClose}>
      <aside className="ml-auto flex h-full w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between border-b border-slate-200 p-5">
          <div>
            <h2 className="font-semibold text-slate-900">原文核验</h2>
            <p className="mt-1 text-sm text-slate-500">{citation.fileName} · 第 {citation.pageNumber} 处</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm">关闭</button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          {error ? <div className="m-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">原文加载失败：{error}<p className="mt-2 text-slate-600">引用片段：{citation.snippet}</p></div> : !source ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">正在加载原文…</div>
          ) : source.fileType === "pdf" ? (
            pages.length > 0 ? <PdfViewer documentId={citation.documentId} pages={pages} renderPage={renderPdfPage} /> : <div className="p-5 text-sm text-slate-400">正在加载 PDF…</div>
          ) : source.fileType === "docx" ? (
            html ? <DocxViewer documentId={citation.documentId} html={html} activeSectionIndex={citation.pageNumber} /> : <div className="p-5 text-sm text-slate-400">正在加载 Word 文档…</div>
          ) : sections.length > 0 ? (
            <TextDocumentViewer documentId={citation.documentId} sections={sections} />
          ) : <div className="p-5 text-sm text-slate-400">正在加载文档段落…</div>}
        </div>
      </aside>
    </div>
  );
}
