import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { basename } from "path";
import { z } from "zod";
import type { DocumentBlock, OcrProvider } from "./types.js";

const bboxSchema = z.object({
  x0: z.number().finite().min(0).max(1),
  y0: z.number().finite().min(0).max(1),
  x1: z.number().finite().min(0).max(1),
  y1: z.number().finite().min(0).max(1),
}).refine((bbox) => bbox.x0 < bbox.x1 && bbox.y0 < bbox.y1, "bbox must have positive area");

const blockKindSchema = z.enum([
  "heading", "paragraph", "list", "table", "figure", "caption", "formula", "footnote",
]);

const responseSchema = z.object({
  pages: z.array(z.object({
    pageNumber: z.number().int().positive(),
    blocks: z.array(z.object({
      text: z.string().trim().min(1),
      kind: blockKindSchema.default("paragraph"),
      bbox: bboxSchema.optional(),
    })),
  })),
});

type Fetch = typeof globalThis.fetch;
type ReadFile = (filePath: string) => Promise<Uint8Array>;
type Sleep = (milliseconds: number) => Promise<void>;

export interface HttpOcrProviderOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  fetch?: Fetch;
  readFile?: ReadFile;
  sleep?: Sleep;
}

export class HttpOcrProvider implements OcrProvider {
  private readonly fetch: Fetch;
  private readonly readFile: ReadFile;
  private readonly sleep: Sleep;

  constructor(private readonly options: HttpOcrProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.readFile = options.readFile ?? fs.readFile;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async recognize(input: { filePath: string; pageNumbers: number[] }): Promise<DocumentBlock[]> {
    const requestedPages = [...new Set(input.pageNumbers)].sort((a, b) => a - b);
    if (requestedPages.length === 0) return [];
    const bytes = await this.readFile(input.filePath);
    const response = await this.requestWithRetry(bytes, basename(input.filePath), requestedPages);
    const payload = responseSchema.parse(await response.json());
    const requested = new Set(requestedPages);
    const blocks: DocumentBlock[] = [];
    const pagesWithText = new Set<number>();

    for (const page of payload.pages) {
      if (!requested.has(page.pageNumber)) {
        throw new Error(`ocr_unrequested_page: page=${page.pageNumber}`);
      }
      for (const block of page.blocks) {
        pagesWithText.add(page.pageNumber);
        blocks.push({
          id: randomUUID(),
          kind: block.kind,
          text: block.text,
          locator: { pageNumber: page.pageNumber, ...(block.bbox ? { bbox: block.bbox } : {}) },
        });
      }
    }

    for (const pageNumber of requestedPages) {
      if (!pagesWithText.has(pageNumber)) throw new Error(`ocr_empty_page: page=${pageNumber}`);
    }
    return blocks;
  }

  private async requestWithRetry(bytes: Uint8Array, fileName: string, pageNumbers: number[]): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const body = new FormData();
        const fileBytes = Uint8Array.from(bytes);
        body.set("file", new Blob([fileBytes.buffer], { type: "application/pdf" }), fileName);
        body.set("pageNumbers", JSON.stringify(pageNumbers));
        const headers: Record<string, string> = {};
        if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
        const response = await this.fetch(this.options.endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (response.ok) return response;
        if (!this.isRetryableStatus(response.status) || attempt === this.options.maxRetries) {
          throw new Error(`ocr_http_error: status=${response.status}`);
        }
        lastError = new Error(`ocr_http_error: status=${response.status}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("ocr_http_error: status=")) {
          const status = Number(error.message.split("=")[1]);
          if (!this.isRetryableStatus(status) || attempt === this.options.maxRetries) throw error;
        }
        lastError = error;
        if (attempt === this.options.maxRetries) break;
      }
      await this.sleep(Math.min(2000, 200 * 2 ** attempt));
    }
    const reason = lastError instanceof Error ? lastError.message : "unknown";
    throw new Error(`ocr_request_failed: attempts=${this.options.maxRetries + 1}; reason=${reason}`);
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }
}
