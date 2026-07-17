import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { createRequire } from "module";
import * as OcrSdk from "@alicloud/ocr-api20210707/dist/client.js";
import { Config } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import { z } from "zod";
import type { DocumentBlock, NormalizedBBox, OcrProvider } from "./types.js";

const advancedResultSchema = z.object({
  content: z.string().optional().default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  prism_wordsInfo: z.array(z.object({
    word: z.string().optional().default(""),
    pos: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  })).optional(),
});

export interface AliyunOcrProviderOptions {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  regionId: string;
  timeoutMs: number;
  maxRetries: number;
}

type RecognizeAllTextRequest = InstanceType<typeof OcrSdk.RecognizeAllTextRequest>;
type RecognizeAllTextResponse = InstanceType<typeof OcrSdk.RecognizeAllTextResponse>;

interface AliyunOcrClient {
  recognizeAllTextWithOptions(
    request: RecognizeAllTextRequest,
    runtime: RuntimeOptions,
  ): Promise<RecognizeAllTextResponse>;
}

const require = createRequire(import.meta.url);
const OcrClient = (require("@alicloud/ocr-api20210707") as { default: new (config: Config) => AliyunOcrClient }).default;

export class AliyunOcrProvider implements OcrProvider {
  private readonly client: AliyunOcrClient;

  constructor(
    private readonly options: AliyunOcrProviderOptions,
    client?: AliyunOcrClient,
  ) {
    this.client = client ?? this.createClient();
  }

  async recognize(input: { filePath: string; pageNumbers: number[] }): Promise<DocumentBlock[]> {
    const pageNumbers = [...new Set(input.pageNumbers)].sort((a, b) => a - b);
    if (pageNumbers.length === 0) return [];

    const blocks: DocumentBlock[] = [];
    for (const pageNumber of pageNumbers) {
      const pageBlocks = await this.recognizePage(input.filePath, pageNumber);
      if (pageBlocks.length === 0) throw new Error(`ocr_empty_page: page=${pageNumber}`);
      blocks.push(...pageBlocks);
    }
    return blocks;
  }

  private createClient(): AliyunOcrClient {
    const config = new Config({
      accessKeyId: this.options.accessKeyId,
      accessKeySecret: this.options.accessKeySecret,
      endpoint: this.options.endpoint,
      regionId: this.options.regionId,
    });
    return new OcrClient(config);
  }

  private async recognizePage(filePath: string, pageNumber: number): Promise<DocumentBlock[]> {
    try {
      const request = new OcrSdk.RecognizeAllTextRequest({
        type: "Advanced",
        pageNo: pageNumber,
        outputCoordinate: "true",
        body: createReadStream(filePath),
      });
      const runtime = new RuntimeOptions({
        readTimeout: this.options.timeoutMs,
        connectTimeout: Math.min(this.options.timeoutMs, 10_000),
        maxAttempts: this.options.maxRetries + 1,
        autoretry: true,
        backoffPolicy: "exponential",
        backoffPeriod: 200,
      });
      const response = await this.client.recognizeAllTextWithOptions(request, runtime);
      if (response.statusCode !== undefined && response.statusCode >= 400) {
        throw new Error(`ocr_http_error: status=${response.statusCode}`);
      }
      if (response.body?.code && response.body.code !== "200") {
        throw new Error(`ocr_provider_error: code=${response.body.code}`);
      }
      const rawData = response.body?.data;
      if (!rawData) return [];
      const data = advancedResultSchema.parse(rawData);
      return this.toBlocks(data, pageNumber);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ocr_")) throw error;
      const requestId = this.readSafeRequestId(error);
      throw new Error(`ocr_request_failed: page=${pageNumber}${requestId ? `; requestId=${requestId}` : ""}`);
    }
  }

  private toBlocks(data: z.infer<typeof advancedResultSchema>, pageNumber: number): DocumentBlock[] {
    const words = data.prism_wordsInfo
      ?.map((word) => ({ text: word.word.trim(), bbox: this.normalizeBBox(word.pos, data.width, data.height) }))
      .filter((word) => word.text);

    if (words?.length) {
      return words.map((word) => ({
        id: randomUUID(),
        kind: "paragraph",
        text: word.text,
        locator: { pageNumber, ...(word.bbox ? { bbox: word.bbox } : {}) },
      }));
    }

    const text = data.content.trim();
    return text ? [{ id: randomUUID(), kind: "paragraph", text, locator: { pageNumber } }] : [];
  }

  private normalizeBBox(
    points: { x: number; y: number }[] | undefined,
    width: number | undefined,
    height: number | undefined,
  ): NormalizedBBox | undefined {
    if (!points?.length || !width || !height) return undefined;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const bbox = {
      x0: Math.max(0, Math.min(...xs) / width),
      y0: Math.max(0, Math.min(...ys) / height),
      x1: Math.min(1, Math.max(...xs) / width),
      y1: Math.min(1, Math.max(...ys) / height),
    };
    return bbox.x0 < bbox.x1 && bbox.y0 < bbox.y1 ? bbox : undefined;
  }

  private readSafeRequestId(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const requestId = (error as { requestId?: unknown }).requestId;
    return typeof requestId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(requestId) ? requestId : undefined;
  }
}
