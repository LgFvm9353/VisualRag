import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import type { Prisma } from "@prisma/client";
import OpenAI from "openai";
import type {
  IngestionTask,
  IngestionStage,
  IngestionProgressEvent,
  LayoutPage,
} from "./types.js";
import { ProgressEmitter } from "./progressEmitter.js";
import { extractTextFromPdf } from "../pdf/textExtractor.js";
import { prisma } from "../db/prisma.js";
import { analyzePdfLayout } from "../pdf/layoutAnalyzer.js";

type StageHandler = (task: IngestionTask) => Promise<void>;

function sanitizePostgresText(text: string) {
  return text.replace(/\u0000/g, "");
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
    });
    this.embeddingModel =
      process.env.OPENAI_EMBEDDING_MODEL || "embedding-2";
  }

  createTask(params: {
    fileName: string;
    fileType: "pdf" | "image" | "zip";
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
  }): IngestionTask {
    const now = new Date();
    const task: IngestionTask = {
      id: params.documentId,
      fileName: params.fileName,
      fileType: "pdf",
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

  private async runTask(task: IngestionTask) {
    const stages: { stage: IngestionStage; handler: StageHandler }[] = [
      { stage: "extracting_text", handler: this.extractText },
      { stage: "layout_analysis", handler: this.layoutAnalysis },
      { stage: "generating_text_embeddings", handler: this.generateTextEmbeddings },
      { stage: "writing_database", handler: this.writeDatabase },
    ];

    try {
      for (let i = 0; i < stages.length; i++) {
        const { stage, handler } = stages[i];
        this.updateTaskStage(task, stage, (i / stages.length) * 100);
        await handler.call(this, task);
      }
      // 持久化 layout 到磁盘（服务重启 / dedup 时需要）
      await this.persistLayout(task);
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
    const result = await extractTextFromPdf(task.sourcePath);
    task.meta = {
      ...(task.meta || {}),
      textPages: result.pages,
    };
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
    if (!process.env.OPENAI_API_KEY) {
      return;
    }
    try {
      const embeddings: {
        pageNumber: number;
        text: string;
        embedding: number[];
      }[] = [];
      const total = textPages.length;
      for (let index = 0; index < textPages.length; index++) {
        const page = textPages[index];
        const cleanedText = sanitizePostgresText(page.text);
        const input =
          cleanedText.length > 8000 ? cleanedText.slice(0, 8000) : cleanedText;
        const response = await this.openai.embeddings.create({
          model: this.embeddingModel,
          input,
        });
        const vector = response.data[0]?.embedding ?? [];
        embeddings.push({
          pageNumber: page.pageNumber,
          text: cleanedText,
          embedding: vector,
        });
        const baseProgress = this.stageBaseProgress("generating_text_embeddings");
        const progress = baseProgress + ((index + 1) / total) * 15;
        this.progressEmitter.emit(task.id, {
          stage: "generating_text_embeddings",
          progress,
        } as IngestionProgressEvent);
      }
      task.meta = {
        ...(task.meta || {}),
        textEmbeddings: embeddings,
      };
      this.tasks.set(task.id, task);
    } catch (err) {
      console.error("generateTextEmbeddings failed", err);
    }
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
      const baseProgress = this.stageBaseProgress("generating_image_embeddings");
      const progress = baseProgress + ((index + 1) / total) * 15;
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
    const textEmbeddings = (task.meta as any)?.textEmbeddings as
      | {
          pageNumber: number;
          text: string;
          embedding: number[];
        }[]
      | undefined;

    if (!textPages || textPages.length === 0) {
      return;
    }

    // 1. 创建 Document 记录
    await prisma.document.create({
      data: {
        id: task.id,
        fileName: task.fileName,
        fileType: "pdf",
        status: "processing",
      },
    });

    // 2. 为每页创建 DocumentSection + Chunk + ChunkEmbedding
    for (let i = 0; i < textPages.length; i++) {
      const page = textPages[i];
      const cleanedText = sanitizePostgresText(page.text);
      const layout = layoutPages?.find((p) => p.pageNumber === page.pageNumber);

      // 创建 DocumentSection
      const section = await prisma.documentSection.create({
        data: {
          documentId: task.id,
          index: page.pageNumber,
          pageNumber: page.pageNumber,
          pageWidth: layout?.width ?? page.width,
          pageHeight: layout?.height ?? page.height,
          content: cleanedText,
          sourceType: "pdf",
        },
      });

      // 为整页创建一个 Chunk（后续可由 ChunkingService 细粒度分块）
      const chunk = await prisma.chunk.create({
        data: {
          documentId: task.id,
          sectionId: section.id,
          chunkIndex: 0,
          content: cleanedText,
          startOffset: 0,
          endOffset: cleanedText.length,
        },
      });

      // 创建 ChunkEmbedding
      const embeddingEntry = textEmbeddings?.find(
        (e) => e.pageNumber === page.pageNumber,
      );
      if (embeddingEntry && embeddingEntry.embedding.length > 0) {
        const embeddingLiteral = `[${embeddingEntry.embedding.join(",")}]`;
        await prisma.$executeRaw`
          INSERT INTO "ChunkEmbedding" ("id", "chunkId", "documentId", "embedding")
          VALUES (${randomUUID()}, ${chunk.id}, ${task.id}, ${embeddingLiteral}::vector)
        `;
      }

      // 3. 布局区域不再存入 DB（前端通过 /tasks/:id/layout 获取）
      // VisualRegion 表已移除，布局数据保留在 task.meta.layoutPages 中
    }

    // 标记处理完成
    await prisma.document.update({
      where: { id: task.id },
      data: { status: "ready" },
    });
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

  private async simulateWork(task: IngestionTask, stage: IngestionStage) {
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const baseProgress = this.stageBaseProgress(stage);
      const progress = baseProgress + (i / steps) * 15;
      this.progressEmitter.emit(task.id, {
        stage,
        progress,
      } as IngestionProgressEvent);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private stageBaseProgress(stage: IngestionStage) {
    switch (stage) {
      case "extracting_text":
        return 5;
      case "layout_analysis":
        return 25;
      case "generating_text_embeddings":
        return 45;
      case "generating_image_embeddings":
        return 65;
      case "writing_database":
        return 85;
      case "completed":
        return 100;
      default:
        return 0;
    }
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
