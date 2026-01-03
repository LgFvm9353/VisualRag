import { randomUUID } from "crypto";
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
    userId: string;
    fileName: string;
    fileType: "pdf" | "image" | "zip";
    sourcePath: string;
  }): IngestionTask {
    const now = new Date();
    const task: IngestionTask = {
      id: randomUUID(),
      userId: params.userId,
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
        const input = page.text.length > 8000 ? page.text.slice(0, 8000) : page.text;
        const response = await this.openai.embeddings.create({
          model: this.embeddingModel,
          input,
        });
        const vector = response.data[0]?.embedding ?? [];
        embeddings.push({
          pageNumber: page.pageNumber,
          text: page.text,
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
    const imageEmbeddings = (task.meta as any)?.imageEmbeddings as
      | {
          regionId: string;
          embedding: number[];
        }[]
      | undefined;
    if (!textPages || textPages.length === 0) {
      return;
    }
    await prisma.document.create({
      data: {
        id: task.id,
        userId: task.userId,
        fileName: task.fileName,
      },
    });
    for (const page of textPages) {
      const layout = layoutPages?.find((p) => p.pageNumber === page.pageNumber);
      await prisma.page.create({
        data: {
          documentId: task.id,
          pageNumber: page.pageNumber,
          width: layout?.width ?? page.width,
          height: layout?.height ?? page.height,
        },
      });
      const textPage = await prisma.textPage.create({
        data: {
          documentId: task.id,
          pageNumber: page.pageNumber,
          text: page.text,
        },
      });
      const embeddingEntry = textEmbeddings?.find(
        (e) => e.pageNumber === page.pageNumber
      );
      if (embeddingEntry && embeddingEntry.embedding.length > 0) {
        const embeddingLiteral = `[${embeddingEntry.embedding.join(",")}]`;
        await prisma.$executeRaw`
          INSERT INTO "TextEmbedding" ("id", "documentId", "textPageId", "content", "embedding")
          VALUES (${randomUUID()}, ${task.id}, ${textPage.id}, ${embeddingEntry.text}, ${embeddingLiteral}::vector)
        `;
      }
      if (layout) {
        for (const region of layout.regions) {
          await prisma.visualRegion.create({
            data: {
              id: region.id,
              documentId: task.id,
              pageNumber: region.pageNumber,
              type: region.type,
              x0: region.bbox.x0,
              y0: region.bbox.y0,
              x1: region.bbox.x1,
              y1: region.bbox.y1,
            },
          });
          const imageEmbeddingEntry = imageEmbeddings?.find(
            (e) => e.regionId === region.id
          );
          if (imageEmbeddingEntry && imageEmbeddingEntry.embedding.length > 0) {
            const embeddingLiteral = `[${imageEmbeddingEntry.embedding.join(",")}]`;
            await prisma.$executeRaw`
              INSERT INTO "ImageEmbedding" ("id", "documentId", "regionId", "embedding")
              VALUES (${randomUUID()}, ${task.id}, ${region.id}, ${embeddingLiteral}::vector)
            `;
          }
        }
      }
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
