import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import type { Prisma } from "@prisma/client";
import OpenAI from "openai";
import type {
  IngestionTask,
  IngestionStage,
  IngestionProgressEvent,
  LayoutPage,
  ExtractedDocumentMetadata,
} from "./types.js";
import { ProgressEmitter } from "./progressEmitter.js";
import { extractTextFromPdf } from "../pdf/textExtractor.js";
import { prisma } from "../db/prisma.js";
import { analyzePdfLayout } from "../pdf/layoutAnalyzer.js";
import {
  extractTextFromDocx,
  toTextPages,
  type DocxParagraph,
} from "../docx/textExtractor.js";
import { extractTextPagesFromHtml, extractTextPagesFromPlainText } from "../text/textExtractor.js";
import { extractTextPagesFromPptx } from "../pptx/textExtractor.js";
import { ChunkingService, type ChunkRecord } from "../modules/search/chunking/chunking.service.js";

type StageHandler = (task: IngestionTask) => Promise<void>;

function sanitizePostgresText(text: string) {
  return text.replace(/\u0000/g, "");
}

function buildExtractedDocumentMetadata(
  fileName: string,
  fileType: IngestionTask["fileType"],
): ExtractedDocumentMetadata | null {
  if (fileType === "image" || fileType === "zip") return null;
  return {
    sourceLabel: fileName,
    publishedAt: null,
    tags: [],
    fileType,
  };
}

export class IngestionPipeline {
  private tasks = new Map<string, IngestionTask>();
  private queue: IngestionTask[] = [];
  private running = false;
  private progressEmitter: ProgressEmitter;
  private openai: OpenAI;
  private embeddingModel: string;

  constructor(progressEmitter: ProgressEmitter) {
    this.progressEmitter = progressEmitter;
    this.openai = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 4 * 60 * 1000, // 4 分钟超时，低于阶段超时的 5 分钟
      maxRetries: 1,
    });
    this.embeddingModel =
      process.env.OPENAI_EMBEDDING_MODEL || "embedding-2";
  }

  createTask(params: {
    fileName: string;
    fileType: "pdf" | "docx" | "text" | "html" | "pptx" | "image" | "zip";
    sourcePath: string;
  }): IngestionTask {
    const now = new Date();
    const task: IngestionTask = {
      id: randomUUID(),
      fileName: params.fileName,
      fileType: params.fileType,
      sourcePath: params.sourcePath,
      createdAt: now,
      updatedAt: now,
      stage: "queued",
      progress: 0,
      meta: {},
    };
    this.tasks.set(task.id, task);
    this.enqueue(task);
    this.progressEmitter.emit(task.id, {
      stage: task.stage,
      progress: task.progress,
      message: "queued",
    });
    return task;
  }

  getTask(taskId: string) {
    return this.tasks.get(taskId);
  }

  /** 创建一个已完成的任务（用于去重时直接返回既有文档） */
  createCompletedTask(params: {
    documentId: string;
    fileName: string;
    sourcePath: string;
    fileType?: string;
  }): IngestionTask {
    const now = new Date();
    const detectedFileType =
      params.fileType ??
      (params.sourcePath?.toLowerCase().endsWith(".docx")
        ? "docx"
        : params.sourcePath?.toLowerCase().endsWith(".txt") ||
            params.sourcePath?.toLowerCase().endsWith(".md")
          ? "text"
          : params.sourcePath?.toLowerCase().endsWith(".html") ||
              params.sourcePath?.toLowerCase().endsWith(".htm")
            ? "html"
            : params.sourcePath?.toLowerCase().endsWith(".pptx")
              ? "pptx"
              : "pdf");
    const task: IngestionTask = {
      id: params.documentId,
      fileName: params.fileName,
      fileType: detectedFileType as IngestionTask["fileType"],
      sourcePath: params.sourcePath,
      createdAt: now,
      updatedAt: now,
      stage: "completed",
      progress: 100,
    };
    this.tasks.set(task.id, task);
    // 发射完成事件，前端通过 Socket.IO 接收后停止 waiting
    this.progressEmitter.emit(task.id, {
      stage: "completed",
      progress: 100,
      message: "completed",
    });
    // 异步加载已持久化的 layout 数据，回填到 task.meta
    loadPersistedLayout(params.sourcePath).then((layoutPages) => {
      if (layoutPages && layoutPages.length > 0) {
        const t = this.tasks.get(params.documentId);
        if (t) {
          t.meta = { ...(t.meta || {}), layoutPages };
        }
      }
    });
    // Word 文档：异步加载持久化 HTML
    if (detectedFileType === "docx") {
      loadPersistedDocxHtml(params.sourcePath).then((html) => {
        if (html) {
          const t = this.tasks.get(params.documentId);
          if (t) {
            t.meta = { ...(t.meta || {}), docxHtml: html };
          }
        }
      });
    }
    return task;
  }

  private enqueue(task: IngestionTask) {
    this.queue.push(task);
    this.runNext();
  }

  private async runNext() {
    if (this.running) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running = true;
    try {
      await this.runTask(task);
    } finally {
      this.running = false;
      if (this.queue.length > 0) {
        this.runNext();
      }
    }
  }

  /** 整个任务的总超时（毫秒） */
  private static readonly TASK_TIMEOUT = 15 * 60 * 1000; // 15 分钟

  private async runTask(task: IngestionTask) {
    const isPdf = task.fileType === "pdf";

    const stages: { stage: IngestionStage; handler: StageHandler }[] = [
      { stage: "extracting_text", handler: this.extractText },
      ...(isPdf
        ? [{ stage: "layout_analysis" as IngestionStage, handler: this.layoutAnalysis }]
        : []),
      { stage: "generating_text_embeddings", handler: this.generateTextEmbeddings },
      ...(isPdf
        ? [{ stage: "generating_image_embeddings" as IngestionStage, handler: this.generateImageEmbeddings }]
        : []),
      { stage: "writing_database", handler: this.writeDatabase },
    ];

    const taskStartTime = Date.now();

    try {
      for (let i = 0; i < stages.length; i++) {
        const { stage, handler } = stages[i];
        const stageBase = (i / stages.length) * 100;
        const stageSpan = 100 / stages.length;
        this.updateTaskStage(task, stage, stageBase);
        // 存储阶段进度信息供 handler 内部使用，
        // 确保 handler 内发出的增量进度与阶段边界对齐
        (task.meta as any)._stageBase = stageBase;
        (task.meta as any)._stageSpan = stageSpan;

        // 任务总超时检查（仅在阶段开始前，不 abort 正在运行的 handler，
        // 避免 handler 在后台继续执行导致 DB 部分写入的竞态）
        const elapsed = Date.now() - taskStartTime;
        if (elapsed > IngestionPipeline.TASK_TIMEOUT) {
          throw new Error(
            `task_timeout: 总处理时间超过 ${IngestionPipeline.TASK_TIMEOUT / 1000}s`,
          );
        }

        await handler.call(this, task);
      }
      // 持久化 layout / HTML 到磁盘（服务重启 / dedup 时需要）
      // 注意：Word HTML 已在 extractText 中提前持久化，此处为兜底
      if (isPdf) {
        await this.persistLayout(task);
      } else if (task.fileType === "docx") {
        await this.persistDocxHtml(task);
      }
      this.updateTaskStage(task, "completed", 100);
    } catch (err) {
      task.error = err instanceof Error ? err.message : String(err);
      this.updateTaskStage(task, "failed", task.progress);
    }
  }

  private updateTaskStage(task: IngestionTask, stage: IngestionStage, progress: number) {
    task.stage = stage;
    task.progress = progress;
    task.updatedAt = new Date();
    this.tasks.set(task.id, task);
    this.progressEmitter.updateStage(task.id, stage, progress);
  }

  private async extractText(task: IngestionTask) {
    if (task.fileType === "docx") {
      const result = await extractTextFromDocx(task.sourcePath);
      task.meta = {
        ...(task.meta || {}),
        textPages: toTextPages(result.paragraphs),
        docxParagraphs: result.paragraphs,
        docxHtml: result.html,
      };
      this.persistDocxHtml(task).catch((err) =>
        console.error("extractText persistDocxHtml failed:", err),
      );
    } else if (task.fileType === "text") {
      const result = await extractTextPagesFromPlainText(task.sourcePath);
      task.meta = {
        ...(task.meta || {}),
        textPages: result.pages,
      };
    } else if (task.fileType === "html") {
      const result = await extractTextPagesFromHtml(task.sourcePath);
      task.meta = {
        ...(task.meta || {}),
        textPages: result.pages,
      };
    } else if (task.fileType === "pptx") {
      const result = await extractTextPagesFromPptx(task.sourcePath);
      task.meta = {
        ...(task.meta || {}),
        textPages: result.pages,
      };
    } else {
      const result = await extractTextFromPdf(task.sourcePath);
      task.meta = {
        ...(task.meta || {}),
        textPages: result.pages,
      };
    }
    this.tasks.set(task.id, task);
  }

  private async layoutAnalysis(task: IngestionTask) {
    const textPages = (task.meta as any)?.textPages as
      | { pageNumber: number; width: number; height: number; text: string }[]
      | undefined;
    if (!textPages || textPages.length === 0) {
      return;
    }
    const layoutPages: LayoutPage[] = await analyzePdfLayout(
      task.sourcePath,
      task.id
    );
    task.meta = {
      ...(task.meta || {}),
      layoutPages,
    };
    this.tasks.set(task.id, task);
  }

  private async generateTextEmbeddings(task: IngestionTask) {
    const textPages = (task.meta as any)?.textPages as
      | { pageNumber: number; width: number; height: number; text: string }[]
      | undefined;
    if (!textPages || textPages.length === 0) {
      return;
    }

    // 文本 embedding 已切换为基于 chunk 的主链生成，
    // 此阶段仅保留进度占位，避免继续对整页/整段做重复 embedding。
    await this.simulateWork(task, "generating_text_embeddings");
  }

  private async generateImageEmbeddings(task: IngestionTask) {
    const layoutPages = (task.meta as any)?.layoutPages as LayoutPage[] | undefined;
    if (!layoutPages || layoutPages.length === 0) {
      return;
    }
    const endpoint = process.env.IMAGE_EMBEDDING_ENDPOINT;
    if (!endpoint) {
      await this.simulateWork(task, "generating_image_embeddings");
      return;
    }
    const regions: {
      pageNumber: number;
      regionId: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
      type: string;
    }[] = [];
    for (const page of layoutPages) {
      for (const region of page.regions) {
        if (region.type !== "figure" && region.type !== "table" && region.type !== "image") {
          continue;
        }
        regions.push({
          pageNumber: region.pageNumber,
          regionId: region.id,
          bbox: region.bbox,
          type: region.type,
        });
      }
    }
    if (regions.length === 0) {
      return;
    }
    const imageEmbeddings: {
      regionId: string;
      embedding: number[];
    }[] = [];
    const total = regions.length;
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index];
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const apiKey = process.env.IMAGE_EMBEDDING_API_KEY;
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const res = await (globalThis as any).fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          filePath: task.sourcePath,
          documentId: task.id,
          pageNumber: region.pageNumber,
          bbox: region.bbox,
          type: region.type,
        }),
      });
      if (!res.ok) {
        continue;
      }
      const json = (await res.json()) as { embedding?: number[] };
      const embedding = json.embedding ?? [];
      if (embedding.length === 0) {
        continue;
      }
      imageEmbeddings.push({
        regionId: region.regionId,
        embedding,
      });
      const baseProgress = this.stageBaseProgress("generating_image_embeddings", task);
      const stageSpan = (task.meta as any)?._stageSpan ?? 15;
      const progress = baseProgress + ((index + 1) / total) * stageSpan;
      task.progress = progress;
      this.progressEmitter.emit(task.id, {
        stage: "generating_image_embeddings",
        progress,
      } as IngestionProgressEvent);
    }
    if (imageEmbeddings.length === 0) {
      return;
    }
    task.meta = {
      ...(task.meta || {}),
      imageEmbeddings,
    };
    this.tasks.set(task.id, task);
  }

  private async writeDatabase(task: IngestionTask) {
    const textPages = (task.meta as any)?.textPages as
      | { pageNumber: number; width: number; height: number; text: string }[]
      | undefined;
    const layoutPages = (task.meta as any)?.layoutPages as LayoutPage[] | undefined;

    if (!textPages || textPages.length === 0) {
      return;
    }

    const isDocx = task.fileType === "docx";
    const isSectionBasedText =
      task.fileType === "text" || task.fileType === "html" || task.fileType === "pptx";
    const docxParagraphs = (task.meta as any)?.docxParagraphs as
      | DocxParagraph[]
      | undefined;

    // 1. 创建 Document 记录
    const metadata = buildExtractedDocumentMetadata(task.fileName, task.fileType);
    await prisma.document.create({
      data: {
        id: task.id,
        fileName: task.fileName,
        fileType: task.fileType,
        status: "processing",
        sourceLabel: metadata?.sourceLabel ?? task.fileName,
        publishedAt: metadata?.publishedAt ? new Date(metadata.publishedAt) : null,
        tags: metadata?.tags ?? [],
        metadataJson: metadata ?? undefined,
      },
    });

    // 2. 创建 DocumentSection
    // 跳过内容过短的段落（如表格中的单个数字），避免产生无意义的检索结果
    const MIN_CONTENT_LENGTH = 20;
    const createdSections: {
      id: string;
      pageNumber?: number | null;
      content: string;
      title?: string | null;
    }[] = [];
    let skippedShortCount = 0;

    for (let i = 0; i < textPages.length; i++) {
      const page = textPages[i];
      const cleanedText = sanitizePostgresText(page.text);

      if (cleanedText.length < MIN_CONTENT_LENGTH) {
        skippedShortCount++;
        continue;
      }
      const layout = layoutPages?.find((p) => p.pageNumber === page.pageNumber);
      const docxPara = docxParagraphs?.[i];

      const sectionData: Record<string, unknown> = {
        documentId: task.id,
        index: page.pageNumber,
        content: cleanedText,
        sourceType: task.fileType,
      };

      if (isDocx || isSectionBasedText) {
        sectionData.pageNumber = null;
        sectionData.pageWidth = null;
        sectionData.pageHeight = null;
        sectionData.headingLevel = docxPara?.headingLevel ?? null;
        sectionData.parentId = docxPara?.parentIndex?.toString() ?? null;
        sectionData.title = docxPara?.headingLevel ? cleanedText.slice(0, 120) : null;
      } else {
        sectionData.pageNumber = page.pageNumber;
        sectionData.pageWidth = layout?.width ?? page.width;
        sectionData.pageHeight = layout?.height ?? page.height;
      }

      const section = await (prisma.documentSection as any).create({
        data: sectionData,
      });

      createdSections.push({
        id: section.id,
        pageNumber: section.pageNumber,
        content: cleanedText,
        title: section.title ?? null,
      });
    }

    if (createdSections.length === 0) {
      await prisma.document.update({
        where: { id: task.id },
        data: { status: "failed" },
      });
      throw new Error(`document_has_no_valid_sections: skippedShortCount=${skippedShortCount}`);
    }

    // 3. 使用 ChunkingService 接入主链分块，而不是继续按整页/整段建一个粗粒度 chunk
    const chunkingService = new ChunkingService(prisma);
    const { chunks } = await chunkingService.chunkDocument(task.id, createdSections, {
      skipContextualRetrieval: createdSections.length > 40,
    });

    // 4. 为真实 chunk 生成向量，建立检索主链
    await this.createChunkEmbeddings(task, chunks);

    // 5. 标记处理完成
    await prisma.document.update({
      where: { id: task.id },
      data: { status: "ready" },
    });
  }

  private async createChunkEmbeddings(task: IngestionTask, chunks: ChunkRecord[]) {
    if (!process.env.OPENAI_API_KEY || chunks.length === 0) {
      return;
    }

    const total = chunks.length;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const input = chunk.content.length > 8000 ? chunk.content.slice(0, 8000) : chunk.content;
      const response = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input,
      });
      const embedding = response.data[0]?.embedding ?? [];
      if (embedding.length > 0) {
        const embeddingLiteral = `[${embedding.join(",")}]`;
        await prisma.$executeRaw`
          INSERT INTO "ChunkEmbedding" ("id", "chunkId", "documentId", "embedding")
          VALUES (${randomUUID()}, ${chunk.id}, ${task.id}, ${embeddingLiteral}::vector)
        `;
      }

      const baseProgress = this.stageBaseProgress("writing_database", task);
      const stageSpan = (task.meta as any)?._stageSpan ?? 15;
      const progress = baseProgress + ((index + 1) / total) * stageSpan;
      task.progress = progress;
      this.progressEmitter.emit(task.id, {
        stage: "writing_database",
        progress,
      } as IngestionProgressEvent);
    }
  }

  /** 持久化 layout 数据到 PDF 旁（服务重启 / dedup 上传时需要） */
  private async persistLayout(task: IngestionTask) {
    const layoutPages = (task.meta as any)?.layoutPages;
    if (!layoutPages || !task.sourcePath) return;
    try {
      const layoutPath = task.sourcePath + ".layout.json";
      await fs.writeFile(layoutPath, JSON.stringify(layoutPages), "utf8");
    } catch (err) {
      console.error("persistLayout failed", err);
    }
  }

  /** 持久化 Word HTML 到 .docx 文件旁（服务重启 / dedup 上传时需要） */
  private async persistDocxHtml(task: IngestionTask) {
    const html = (task.meta as any)?.docxHtml as string | undefined;
    if (!html || !task.sourcePath) return;
    try {
      const htmlPath = task.sourcePath + ".docx.html";
      await fs.writeFile(htmlPath, html, "utf8");
    } catch (err) {
      console.error("persistDocxHtml failed", err);
    }
  }

  private async simulateWork(task: IngestionTask, stage: IngestionStage) {
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const baseProgress = this.stageBaseProgress(stage, task);
      const stageSpan = (task.meta as any)?._stageSpan ?? 15;
      const progress = baseProgress + (i / steps) * stageSpan;
      task.progress = progress;
      this.progressEmitter.emit(task.id, {
        stage,
        progress,
      } as IngestionProgressEvent);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * 动态计算阶段基准进度。
   * 基准值来自 runTask() 中根据实际阶段数计算的 _stageBase，
   * 而非硬编码值，确保 docx (3 阶段) 和 PDF (5 阶段) 都正确对齐。
   */
  private stageBaseProgress(_stage: IngestionStage, task: IngestionTask): number {
    return (task.meta as any)?._stageBase ?? 0;
  }
}

/** 从磁盘加载已持久化的 layout 数据（用于服务重启后或 dedup 上传） */
export async function loadPersistedLayout(sourcePath: string): Promise<any[] | null> {
  try {
    const layoutPath = sourcePath + ".layout.json";
    const raw = await fs.readFile(layoutPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从磁盘加载已持久化的 Word HTML（用于服务重启后或 dedup 上传） */
export async function loadPersistedDocxHtml(
  sourcePath: string,
): Promise<string | null> {
  try {
    const htmlPath = sourcePath + ".docx.html";
    return await fs.readFile(htmlPath, "utf8");
  } catch {
    return null;
  }
}
