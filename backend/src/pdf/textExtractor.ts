import { promises as fs } from "fs";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";

if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export interface PageTextExtractionResult {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
}

export interface TextExtractionResult {
  pages: PageTextExtractionResult[];
}

export async function extractTextFromPdf(filePath: string): Promise<TextExtractionResult> {
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({ data });
  const pdf = (await loadingTask.promise) as PDFDocumentProxy;
  const pages: PageTextExtractionResult[] = [];
  const total = pdf.numPages;
  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items: {
      text: string;
      x: number;
      y: number;
    }[] = [];
    const height = viewport.height || 1;
    for (const rawItem of textContent.items as any[]) {
      const item = rawItem as any;
      if (!item || typeof item.str !== "string" || !item.transform) {
        continue;
      }
      const value = item.str;
      if (!value || value.length === 0) {
        continue;
      }
      const transform = item.transform as number[];
      const x = transform[4] as number;
      const y = transform[5] as number;
      items.push({
        text: value,
        x,
        y,
      });
    }
    items.sort((a, b) => {
      if (a.y === b.y) {
        return a.x - b.x;
      }
      return b.y - a.y;
    });
    const lineThreshold = height * 0.012;
    const lines: { items: typeof items }[] = [];
    let currentLine: { items: typeof items } | null = null;
    let currentY = 0;
    for (const item of items) {
      if (!currentLine) {
        currentLine = { items: [item] as any };
        currentY = item.y;
        lines.push(currentLine);
        continue;
      }
      const dy = Math.abs(item.y - currentY);
      if (dy <= lineThreshold) {
        currentLine.items.push(item as any);
        currentY = (currentY * (currentLine.items.length - 1) + item.y) / currentLine.items.length;
      } else {
        currentLine = { items: [item] as any };
        currentY = item.y;
        lines.push(currentLine);
      }
    }
    const segments: string[] = [];
    for (const line of lines) {
      if (!line.items || line.items.length === 0) {
        continue;
      }
      const lineText = (line.items as any[])
        .map((it) => String(it.text || ""))
        .join("")
        .trim();
      if (!lineText) {
        continue;
      }
      segments.push(lineText);
    }
    const text = segments.join("\n");
    pages.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      text,
    });
  }
  await pdf.cleanup();
  return { pages };
}
