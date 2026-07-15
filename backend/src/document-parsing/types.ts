export interface NormalizedBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SourceLocator {
  pageNumber?: number;
  bbox?: NormalizedBBox;
  sectionPath?: string[];
  paragraphIndex?: number;
  blockIndex?: number;
  assetId?: string;
}

export type DocumentBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "figure"
  | "caption"
  | "formula"
  | "footnote";

export interface DocumentBlock {
  id: string;
  kind: DocumentBlockKind;
  text: string;
  locator: SourceLocator;
  headingLevel?: number;
  parentBlockId?: string;
}

export interface DocumentLayoutRegion {
  id: string;
  pageNumber: number;
  type: "figure" | "table" | "chart" | "image" | "other";
  bbox: NormalizedBBox;
  textSnippet?: string;
  assetId?: string;
}

export interface DocumentLayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  regions: DocumentLayoutRegion[];
}

export interface ParseWarning {
  code: "ocr_required" | "parser_warning";
  message: string;
  locator?: SourceLocator;
}

export interface ParsedDocument {
  blocks: DocumentBlock[];
  warnings: ParseWarning[];
  artifacts: {
    html?: string;
    layout?: DocumentLayoutPage[];
  };
  metadata: Record<string, unknown>;
}

export interface ParseDocumentInput {
  filePath: string;
  documentId: string;
}

export interface DocumentParser {
  readonly id: string;
  readonly mediaTypes: readonly string[];
  parse(input: ParseDocumentInput): Promise<ParsedDocument>;
}

export interface OcrProvider {
  recognize(input: { filePath: string; pageNumbers: number[] }): Promise<DocumentBlock[]>;
}
