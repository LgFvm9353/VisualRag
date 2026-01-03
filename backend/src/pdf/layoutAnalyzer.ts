import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import type { LayoutPage, VisualRegion } from "../pipeline/types.js";

export async function analyzePdfLayout(
  filePath: string,
  documentId: string
): Promise<LayoutPage[]> {
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({ data });
  const pdf = (await loadingTask.promise) as PDFDocumentProxy;
  const pages: LayoutPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items: {
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    const width = viewport.width || 1;
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
      const w = typeof item.width === "number" ? (item.width as number) : 0;
      const h = typeof item.height === "number" ? (item.height as number) : 0;
      items.push({
        text: value,
        x,
        y,
        width: w,
        height: h,
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
    const regions: VisualRegion[] = [];
    for (const line of lines) {
      if (!line.items || line.items.length === 0) {
        continue;
      }
      const texts = line.items.map((it: any) => String(it.text || "")).join("").trim();
      if (!texts) {
        continue;
      }
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const it of line.items as any[]) {
        const x0 = it.x;
        const x1 = it.x + (typeof it.width === "number" ? it.width : 0);
        const y0 = it.y;
        const y1 = it.y + (typeof it.height === "number" ? it.height : 0);
        if (x0 < minX) minX = x0;
        if (x1 > maxX) maxX = x1;
        if (y0 < minY) minY = y0;
        if (y1 > maxY) maxY = y1;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
        continue;
      }
      const paddingY = height * 0.004;
      const nx0 = minX / width;
      const nx1 = maxX / width;
      const ny0 = Math.max(0, (minY - paddingY) / height);
      const ny1 = Math.min(1, (maxY + paddingY) / height);
      regions.push({
        id: randomUUID(),
        documentId,
        pageNumber: i,
        type: "other",
        bbox: {
          x0: nx0,
          y0: ny0,
          x1: nx1,
          y1: ny1,
        },
      });
    }
    pages.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      regions,
    });
  }
  await pdf.cleanup();
  return pages;
}
