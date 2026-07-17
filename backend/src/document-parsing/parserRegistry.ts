import type { DocumentParser } from "./types.js";
import { config } from "../config/env.js";
import { AliyunOcrProvider } from "./aliyunOcrProvider.js";
import { HttpOcrProvider } from "./httpOcrProvider.js";
import { PdfDocumentParser, loadPdf } from "./pdfDocumentParser.js";
import { DocxDocumentParser } from "./docxDocumentParser.js";

export class ParserRegistry {
  private readonly parsers = new Map<string, DocumentParser>();

  constructor(parsers: readonly DocumentParser[] = []) {
    for (const parser of parsers) this.register(parser);
  }

  register(parser: DocumentParser): void {
    const keys = parser.mediaTypes.map((mediaType) => mediaType.toLowerCase());
    for (const key of keys) {
      if (this.parsers.has(key)) throw new Error(`Parser already registered for ${key}`);
    }
    for (const key of keys) this.parsers.set(key, parser);
  }

  get(mediaType: string): DocumentParser | undefined {
    return this.parsers.get(mediaType.toLowerCase());
  }
}

export function createDefaultParserRegistry(): ParserRegistry {
  const ocrConfig = config.ocr;
  const ocrProvider = !ocrConfig
    ? undefined
    : ocrConfig.provider === "aliyun"
      ? new AliyunOcrProvider(ocrConfig)
      : new HttpOcrProvider(ocrConfig);
  return new ParserRegistry([
    new PdfDocumentParser(loadPdf, ocrProvider),
    new DocxDocumentParser(),
  ]);
}
