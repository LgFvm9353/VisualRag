'use client';

import type { FC, RefObject } from "react";
import { useEffect, useRef } from "react";
import { usePdfViewerStore } from "../store/pdfViewerStore";

export interface PdfPageMetadata {
  pageNumber: number;
  width: number;
  height: number;
}

export interface PdfViewerProps {
  documentId: string;
  pages: PdfPageMetadata[];
  renderPage: (
    page: PdfPageMetadata,
    canvasRef: RefObject<HTMLCanvasElement>
  ) => void | Promise<void>;
}

export const PdfViewer: FC<PdfViewerProps> = ({
  documentId,
  pages,
  renderPage,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});

  const activeReference = usePdfViewerStore((s) => s.activeReference);
  const setCurrentPage = usePdfViewerStore((s) => s.setCurrentPage);

  useEffect(() => {
    pages.forEach((page) => {
      const pageRef = pageRefs.current[page.pageNumber];
      const canvasRef = canvasRefs.current[page.pageNumber];
      if (pageRef && canvasRef) {
        renderPage(page, { current: canvasRef });
      }
    });
  }, [pages, renderPage]);

  useEffect(() => {
    if (!activeReference) return;
    if (activeReference.documentId !== documentId) return;
    const pageRef = pageRefs.current[activeReference.pageNumber];
    if (!pageRef) return;
    pageRef.scrollIntoView({ behavior: "smooth", block: "center" });
    setCurrentPage(activeReference.pageNumber);
  }, [activeReference, documentId, setCurrentPage]);

  return (
    <div ref={containerRef} className="h-full w-full overflow-y-auto overflow-x-hidden scroll-smooth p-8">
      <div className="mx-auto flex max-w-max flex-col gap-8">
        {pages.map((page) => (
          <div
            key={page.pageNumber}
            ref={(el) => {
              pageRefs.current[page.pageNumber] = el;
            }}
            className="relative flex justify-center transition-transform duration-300 ease-out"
          >
            <div className="relative inline-block overflow-hidden rounded-sm shadow-[0_2px_12px_rgba(0,0,0,0.08)] ring-1 ring-black/5">
              <canvas
                ref={(el) => {
                  canvasRefs.current[page.pageNumber] = el;
                }}
                width={page.width}
                height={page.height}
                className="block bg-white"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
