import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import type {
  DocumentLayoutPage,
  DocumentLayoutRegion,
  DocumentParser,
  OcrProvider,
  ParsedDocument,
} from "./types.js";

if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

export interface PdfTextItem { text: string; x: number; y: number; width: number; height: number }
export interface PdfPageData { pageNumber: number; width: number; height: number; items: PdfTextItem[] }
export interface PdfDocumentHandle { pages: PdfPageData[]; cleanup(): Promise<void> | void }
export type PdfLoader = (filePath: string) => Promise<PdfDocumentHandle>;

export async function loadPdf(filePath: string): Promise<PdfDocumentHandle> {
  const data = new Uint8Array(await fs.readFile(filePath));
  const pdf = (await getDocument({ data }).promise) as PDFDocumentProxy;
  try {
    const pages: PdfPageData[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = (content.items as any[]).flatMap((item): PdfTextItem[] => {
        if (!item || typeof item.str !== "string" || !item.str || !item.transform) return [];
        const x = item.transform[4];
        const y = item.transform[5];
        const width = item.width ?? 0;
        const height = item.height ?? 0;
        if (![x, y, width, height].every(Number.isFinite)) return [];
        return [{ text: item.str, x, y, width, height }];
      });
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, items });
    }
    return { pages, cleanup: () => pdf.cleanup() };
  } catch (error) {
    await pdf.cleanup();
    throw error;
  }
}

function isValidTextItem(item: PdfTextItem): boolean {
  return Boolean(item.text) &&
    [item.x, item.y, item.width, item.height].every(Number.isFinite) &&
    item.width > 0 &&
    item.height > 0;
}

function clampNormalized(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function linesFor(page: PdfPageData, items: PdfTextItem[]): PdfTextItem[][] {
  const sorted = [...items].sort((a, b) => a.y === b.y ? a.x - b.x : b.y - a.y);
  const lines: PdfTextItem[][] = [];
  for (const item of sorted) {
    const line = lines.at(-1);
    if (!line || Math.abs(item.y - line.reduce((sum, value) => sum + value.y, 0) / line.length) > page.height * 0.012) lines.push([item]);
    else line.push(item);
  }
  return lines;
}

export class PdfDocumentParser implements DocumentParser {
  readonly id = "pdf";
  readonly mediaTypes = ["application/pdf"];
  constructor(
    private readonly loader: PdfLoader = loadPdf,
    private readonly ocrProvider?: OcrProvider,
  ) {}

  async parse({ filePath, documentId }: { filePath: string; documentId: string }): Promise<ParsedDocument> {
    const pdf = await this.loader(filePath);
    try {
      const blocks: ParsedDocument["blocks"] = [];
      const warnings: ParsedDocument["warnings"] = [];
      const layout: DocumentLayoutPage[] = [];
      for (const page of pdf.pages) {
        if (!Number.isFinite(page.width) || page.width <= 0 || !Number.isFinite(page.height) || page.height <= 0) {
          throw new Error(`invalid_pdf_page_dimensions: page=${page.pageNumber}`);
        }
        const regions: DocumentLayoutRegion[] = [];
        const validItems = page.items.filter(isValidTextItem);
        if (validItems.length !== page.items.length) {
          warnings.push({ code: "parser_warning", message: "Skipped PDF text items with invalid coordinates or dimensions", locator: { pageNumber: page.pageNumber } });
        }
        const lines = linesFor(page, validItems);
        if (lines.length === 0) warnings.push({ code: "ocr_required", message: "PDF page has no usable text layer; OCR is required", locator: { pageNumber: page.pageNumber } });
        const pageTexts: string[] = [];
        for (const line of lines) {
          const text = line.map((item) => item.text).join("").trim();
          if (!text) continue;
          pageTexts.push(text);
          const minX = Math.min(...line.map((item) => item.x));
          const maxX = Math.max(...line.map((item) => item.x + item.width));
          const minY = Math.min(...line.map((item) => item.y));
          const maxY = Math.max(...line.map((item) => item.y + item.height));
          const bbox = {
            x0: clampNormalized(minX / page.width),
            y0: clampNormalized((minY - page.height * .004) / page.height),
            x1: clampNormalized(maxX / page.width),
            y1: clampNormalized((maxY + page.height * .004) / page.height),
          };
          if (bbox.x0 < bbox.x1 && bbox.y0 < bbox.y1) {
            regions.push({ id: randomUUID(), pageNumber: page.pageNumber, type: "other", bbox, textSnippet: text });
          }
        }
        if (pageTexts.length > 0) {
          blocks.push({ id: randomUUID(), kind: "paragraph", text: pageTexts.join("\n"), locator: { pageNumber: page.pageNumber } });
        }
        layout.push({ pageNumber: page.pageNumber, width: page.width, height: page.height, regions });
      }
      const missingPages = warnings
        .filter((warning) => warning.code === "ocr_required")
        .map((warning) => warning.locator?.pageNumber)
        .filter((pageNumber): pageNumber is number => pageNumber !== undefined);
      if (this.ocrProvider && missingPages.length > 0) {
        const ocrBlocks = await this.ocrProvider.recognize({ filePath, pageNumbers: missingPages });
        blocks.push(...ocrBlocks);
        const completedPages = new Set(
          ocrBlocks
            .filter((block) => block.text.trim())
            .map((block) => block.locator.pageNumber)
            .filter((pageNumber): pageNumber is number => pageNumber !== undefined),
        );
        for (let index = warnings.length - 1; index >= 0; index--) {
          const warning = warnings[index];
          const pageNumber = warning.locator?.pageNumber;
          if (warning.code === "ocr_required" && pageNumber !== undefined && completedPages.has(pageNumber)) {
            warnings.splice(index, 1);
          }
        }
      }
      return { blocks, warnings, artifacts: { layout }, metadata: {} };
    } finally { await pdf.cleanup(); }
  }
}
