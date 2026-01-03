export type IngestionStage =
  | "queued"
  | "extracting_text"
  | "layout_analysis"
  | "generating_text_embeddings"
  | "generating_image_embeddings"
  | "writing_database"
  | "completed"
  | "failed";

export interface IngestionTask {
  id: string;
  userId: string;
  fileName: string;
  fileType: "pdf" | "image" | "zip";
  sourcePath: string;
  createdAt: Date;
  updatedAt: Date;
  stage: IngestionStage;
  progress: number;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface NormalizedBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type RegionType = "figure" | "table" | "chart" | "image" | "other";

export interface VisualRegion {
  id: string;
  documentId: string;
  pageNumber: number;
  type: RegionType;
  bbox: NormalizedBBox;
  textSnippet?: string;
  imageAssetPath?: string;
}

export interface TextChunk {
  id: string;
  documentId: string;
  pageNumber: number;
  content: string;
  sourceBlocks: string[];
  relatedRegionIds?: string[];
}

export interface LayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  regions: VisualRegion[];
}

export interface IngestionProgressEvent {
  taskId: string;
  stage: IngestionStage;
  progress: number;
  message?: string;
  meta?: {
    page?: number;
    totalPages?: number;
    currentRegionIndex?: number;
    totalRegions?: number;
  };
}
