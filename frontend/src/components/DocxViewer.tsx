"use client";

import type { FC } from "react";
import { useEffect, useRef, useMemo } from "react";
import { usePdfViewerStore } from "@/store/pdfViewerStore";

export interface DocxViewerProps {
  documentId: string;
  /** mammoth 生成的完整 HTML */
  html: string;
  /** 可选：需要高亮的段落索引 */
  activeSectionIndex?: number;
}

/** DocxViewer 内容样式（注入到 document head，单例） */
const DOCX_CONTENT_CSS = `
  .docx-content {
    font-family: "Georgia", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif;
    font-size: 1.0625rem;
    line-height: 1.85;
    word-break: break-word;
  }
  .docx-content h1 {
    font-size: 2rem; font-weight: 700; margin-top: 2.5rem; margin-bottom: 1rem;
    line-height: 1.3; color: #0f172a; letter-spacing: -0.02em;
    border-bottom: 1px solid #e2e8f0; padding-bottom: 0.5rem;
  }
  .docx-content h2 {
    font-size: 1.5rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.75rem;
    line-height: 1.35; color: #1e293b;
  }
  .docx-content h3 {
    font-size: 1.25rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem;
    line-height: 1.4; color: #334155;
  }
  .docx-content h4, .docx-content h5, .docx-content h6 {
    font-size: 1.1rem; font-weight: 600; margin-top: 1.25rem; margin-bottom: 0.5rem;
    line-height: 1.4; color: #475569;
  }
  .docx-content p {
    margin-top: 0.5rem; margin-bottom: 0.5rem; text-indent: 2em;
  }
  .docx-content p[data-heading="true"] { text-indent: 0; }
  .docx-content ul, .docx-content ol {
    margin-top: 0.5rem; margin-bottom: 0.5rem; padding-left: 1.5rem;
  }
  .docx-content li { margin-top: 0.25rem; margin-bottom: 0.25rem; }
  .docx-content ul > li { list-style-type: disc; }
  .docx-content ol > li { list-style-type: decimal; }
  .docx-content blockquote {
    border-left: 4px solid #6366f1; padding-left: 1rem; margin: 1rem 0;
    color: #475569; font-style: italic;
  }
  .docx-content table {
    width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9375rem;
  }
  .docx-content th, .docx-content td {
    border: 1px solid #e2e8f0; padding: 0.5rem 0.75rem; text-align: left;
  }
  .docx-content th { background: #f8fafc; font-weight: 600; }
  .docx-content img {
    max-width: 100%; height: auto; border-radius: 0.5rem; margin: 0.75rem 0;
  }
  .docx-content strong { font-weight: 600; color: #1e293b; }
  .docx-content em { font-style: italic; }
`;

/**
 * Word 文档查看器。
 *
 * 将 mammoth 生成的 HTML 渲染到可滚动容器中，
 * 应用类 Typography 样式，支持搜索结果的段落级高亮。
 */
export const DocxViewer: FC<DocxViewerProps> = ({
  documentId,
  html,
  activeSectionIndex,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  const activeReference = usePdfViewerStore((s) => s.activeReference);
  const setCurrentPage = usePdfViewerStore((s) => s.setCurrentPage);

  // 注入样式到 document head（单例）
  useEffect(() => {
    if (styleRef.current) return;
    const style = document.createElement("style");
    style.setAttribute("data-docx-viewer", "");
    style.textContent = DOCX_CONTENT_CSS;
    document.head.appendChild(style);
    styleRef.current = style;
    return () => {
      style.remove();
      styleRef.current = null;
    };
  }, []);

  // 当 activeReference 变更时，滚动到对应段落
  useEffect(() => {
    if (!activeReference) return;
    if (activeReference.documentId !== documentId) return;

    const sectionIndex =
      (activeReference as any).sectionIndex ?? activeReference.pageNumber;
    if (sectionIndex == null) return;

    const content = contentRef.current;
    if (!content) return;

    const target = content.querySelector(
      `[data-para-index="${sectionIndex}"]`,
    ) as HTMLElement | null;
    if (!target) return;

    setCurrentPage(sectionIndex);
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [activeReference, documentId, setCurrentPage]);

  // HTML 处理：注入段落索引 + 清理
  const processedHtml = useMemo(() => {
    return injectParagraphIndices(html);
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-y-auto overflow-x-hidden scroll-smooth"
    >
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div
          ref={contentRef}
          className="docx-content text-slate-800"
          dangerouslySetInnerHTML={{ __html: processedHtml }}
        />
      </div>

    </div>
  );
};

/**
 * 向 mammoth HTML 注入段落索引（data-para-index）和 heading 标记。
 *
 * 索引从 1 开始，与后端 toTextPages() 的 1-based pageNumber 对齐。
 * 只匹配 <h1>-<h6> 和 <p> 标签，与 parseParagraphsFromHtml() 的标签集一致。
 */
function injectParagraphIndices(html: string): string {
  let paraIndex = 1;

  // 匹配块级标签：h1-h6, p（与 parseParagraphsFromHtml 标签集对齐）
  return html.replace(
    /<(h[1-6]|p)\b([^>]*)>/gi,
    (match, tag: string, attrs: string) => {
      const isHeading = /^h[1-6]$/i.test(tag);
      const headingAttr = isHeading ? ' data-heading="true"' : "";
      const result = `<${tag}${attrs} data-para-index="${paraIndex}"${headingAttr}>`;
      paraIndex++;
      return result;
    },
  );
}
