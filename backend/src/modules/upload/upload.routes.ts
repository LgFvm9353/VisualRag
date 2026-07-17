import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { join } from "path";
import { pipeline as streamPipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { promises as fs } from "fs";
import type { IngestionPipeline } from "../../pipeline/ingestionPipeline.js";
import type { PrismaClient } from "@prisma/client";
import {
  loadUploadIndex,
  saveUploadIndex,
  loadUploadMetadata,
  saveUploadMetadata,
  withUploadLock,
  withIndexLock,
  getUploadsDir,
  getChunksRootDir,
  writeChunk,
  assembleFile,
  shouldReuseCompletedResult,
} from "./upload.service.js";
import { resolveDocumentSourcePath } from "./source-path.js";
import { claimDocument } from "./document-claim.service.js";

/** 验证去重条目对应的 DB 文档是否已处理完成 */
async function isDocumentReady(
  prisma: PrismaClient,
  documentId: string,
): Promise<boolean> {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { status: true },
    });
    return doc?.status === "ready";
  } catch {
    return false;
  }
}

interface UploadPluginOptions {
  pipeline: IngestionPipeline;
  prisma: PrismaClient;
}

function getContentType(fileType: string, sourcePath?: string) {
  if (fileType === "docx" || sourcePath?.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (fileType === "pptx" || sourcePath?.toLowerCase().endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (fileType === "text" || sourcePath?.toLowerCase().endsWith(".txt") || sourcePath?.toLowerCase().endsWith(".md")) {
    return "text/plain; charset=utf-8";
  }
  if (fileType === "html" || sourcePath?.toLowerCase().endsWith(".html") || sourcePath?.toLowerCase().endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  return "application/pdf";
}

function detectFileType(fileName: string): IngestionPipeline["createTask"] extends (params: infer P) => any
  ? P extends { fileType: infer T }
    ? T
    : never
  : never {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".docx")) return "docx" as any;
  if (lower.endsWith(".pptx")) return "pptx" as any;
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text" as any;
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html" as any;
  return "pdf" as any;
}

export const uploadRoutes: FastifyPluginAsync<UploadPluginOptions> = async (
  app,
  opts,
) => {
  // ---- POST /upload/init ----
  app.post("/upload/init", async (request, reply) => {
    const schema = z.object({
      fileName: z.string().min(1),
      fileSize: z.number().int().min(1),
      hash: z.string().min(1),
      chunkSize: z.number().int().min(1),
      existingUploadId: z.string().uuid().optional(),
    });
    const body = schema.parse(request.body);

    await fs.mkdir(getUploadsDir(), { recursive: true });
    await fs.mkdir(getChunksRootDir(), { recursive: true });

    const index = await loadUploadIndex();
    const indexed = index[body.hash];
    const databaseDocument = await opts.prisma.document.findUnique({
      where: { contentHash: body.hash },
      select: { id: true, status: true },
    });
    const existing = indexed ?? (databaseDocument
      ? { documentId: databaseDocument.id, sourcePath: join(getUploadsDir(), body.hash) }
      : undefined);
    if (existing?.sourcePath && existing?.documentId) {
      // 验证 DB 中文档确实已完成处理（防止上次管道失败的残留条目）
      const ready = await isDocumentReady(opts.prisma, existing.documentId);
      if (!ready) {
        // 管道未完成 → 清理过期条目，回退到正常上传
        await withIndexLock(async () => {
          const idx = await loadUploadIndex();
          delete idx[body.hash];
          await saveUploadIndex(idx);
        });
      } else {
        // 检查文件是否确实存在于磁盘（用户可能手动删了 uploads 目录）
        let fileExists = false;
        try {
          await fs.access(existing.sourcePath);
          fileExists = true;
        } catch {
          // 文件不存在 → 清理过期 index 条目，回退到正常上传流程
          await withIndexLock(async () => {
            const idx = await loadUploadIndex();
            delete idx[body.hash];
            await saveUploadIndex(idx);
          });
        }
        if (fileExists) {
          const task = opts.pipeline.createCompletedTask({
            documentId: existing.documentId,
            fileName: body.fileName,
            sourcePath: existing.sourcePath,
            fileType: detectFileType(body.fileName),
          });
          reply.send({ fast: true, taskId: task.id, documentId: existing.documentId });
          return;
        }
      }
    }

    const existingId = body.existingUploadId;
    let uploadId: string | undefined = existingId;
    let metadata: Awaited<ReturnType<typeof loadUploadMetadata>> = null;
    if (existingId) {
      metadata = await withUploadLock(existingId, () => loadUploadMetadata(existingId));
      if (metadata && (
        metadata.fileName !== body.fileName
        || metadata.fileSize !== body.fileSize
        || metadata.hash !== body.hash
        || metadata.chunkSize !== body.chunkSize
      )) {
        reply.code(409).send({ error: "upload_metadata_mismatch" });
        return;
      }
    }

    if (!metadata) {
      const totalChunks = Math.ceil(body.fileSize / body.chunkSize);
      const tempDir = join(getChunksRootDir(), randomUUID());
      uploadId = randomUUID();
      metadata = {
        id: uploadId,
        fileName: body.fileName,
        fileSize: body.fileSize,
        hash: body.hash,
        chunkSize: body.chunkSize,
        totalChunks,
        receivedChunks: [],
        tempDir,
        createdAt: new Date().toISOString(),
      };
      await saveUploadMetadata(metadata);
    }

    reply.send({
      fast: false,
      uploadId: metadata.id,
      uploadedChunks: metadata.receivedChunks,
      chunkSize: metadata.chunkSize,
      totalChunks: metadata.totalChunks,
    });
  });

  // ---- PUT /upload/chunk ----
  app.put("/upload/chunk", async (request, reply) => {
    const schema = z.object({
      uploadId: z.string().uuid(),
      index: z.coerce.number().int().min(0),
    });
    const params = schema.parse(request.query as any);
    const metadata = await withUploadLock(params.uploadId, () =>
      loadUploadMetadata(params.uploadId),
    );
    if (!metadata) {
      reply.code(404).send({ error: "upload_not_found" });
      return;
    }
    if (params.index >= metadata.totalChunks) {
      reply.code(400).send({ error: "invalid_chunk_index" });
      return;
    }
    await fs.mkdir(metadata.tempDir, { recursive: true });
    const chunkPath = join(metadata.tempDir, `${params.index}.part`);
    const writeStream = createWriteStream(chunkPath);
    try {
      await streamPipeline(request.body as any, writeStream);
    } catch (err) {
      await fs.unlink(chunkPath).catch(() => {});
      throw err;
    }
    await withUploadLock(params.uploadId, async () => {
      const current = await loadUploadMetadata(params.uploadId);
      if (!current) return;
      if (!current.receivedChunks.includes(params.index)) {
        current.receivedChunks.push(params.index);
        current.receivedChunks.sort((a, b) => a - b);
        await saveUploadMetadata(current);
      }
      reply.send({ ok: true });
    });
  });

  // ---- POST /upload/complete ----
  app.post("/upload/complete", async (request, reply) => {
    const schema = z.object({ uploadId: z.string().uuid() });
    const body = schema.parse(request.body);

    const metadata = await withUploadLock(body.uploadId, () =>
      loadUploadMetadata(body.uploadId),
    );
    if (!metadata) {
      reply.code(404).send({ error: "upload_not_found" });
      return;
    }
    if (metadata.completedResult) {
      const cachedTask = opts.pipeline.getTask(metadata.completedResult.taskId);
      if (shouldReuseCompletedResult(cachedTask)) {
        reply.send(metadata.completedResult);
        return;
      }
      await withUploadLock(metadata.id, async () => {
        const current = await loadUploadMetadata(metadata.id);
        if (!current) return;
        delete current.completedResult;
        await saveUploadMetadata(current);
      });
    }
    if (metadata.receivedChunks.length !== metadata.totalChunks) {
      reply.code(400).send({ error: "chunks_incomplete" });
      return;
    }

    // 用 index 锁保护「读→改→写」操作，防止并发写损坏
    const result = await withIndexLock(async () => {
      const index = await loadUploadIndex();

      // 去重：其他并发上传可能已经完成并写入了同一个 hash
      const existing = index[metadata.hash];
      if (existing?.documentId) {
        // 验证 DB 中文档确实已完成处理
        const ready = await isDocumentReady(opts.prisma, existing.documentId);
        if (!ready) {
          // 管道未完成（上次可能失败）→ 清理过期条目
          delete index[metadata.hash];
        } else {
          // 确认文件仍在磁盘上（用户可能手动删除）
          let fileExists = false;
          try {
            await fs.access(existing.sourcePath);
            fileExists = true;
          } catch {
            delete index[metadata.hash];
          }
          if (fileExists) {
            await saveUploadIndex(index);
            return { taskId: null as string | null, documentId: existing.documentId, sourcePath: existing.sourcePath, skipped: true };
          }
          // 文件不存在 → 清理过期条目，回退到正常入库流程
        }
      }

      // 内容寻址：用 hash 做文件名，同一份文件只存一份
      const uploadsDir = getUploadsDir();
      await fs.mkdir(uploadsDir, { recursive: true });
      const finalPath = join(uploadsDir, metadata.hash);

      // 仅在文件不存在时才组装（双重检查）
      let hashOnDisk: string | undefined;
      try {
        const { createHash } = await import("crypto");
        const data = await fs.readFile(finalPath);
        hashOnDisk = createHash("sha256").update(data).digest("hex");
      } catch {
        // 文件不存在，正常
      }

      if (hashOnDisk !== metadata.hash) {
        const digest = await assembleFile(metadata, finalPath);
        if (digest !== metadata.hash) {
          await fs.unlink(finalPath).catch(() => {});
          throw new Error("hash_mismatch");
        }
      }

      // 数据库唯一 contentHash 是最终幂等防线；本地 index 仅作为路径缓存。
      const candidateDocumentId = randomUUID();
      const claim = await claimDocument(opts.prisma, {
        id: candidateDocumentId,
        contentHash: metadata.hash,
        fileName: metadata.fileName,
        fileType: detectFileType(metadata.fileName),
      });

      index[metadata.hash] = { sourcePath: finalPath, documentId: claim.document.id };
      await saveUploadIndex(index);

      if (claim.action === "ready") {
        return {
          taskId: null as string | null,
          documentId: claim.document.id,
          sourcePath: finalPath,
          skipped: true,
        };
      }

      // 只有哈希认领者或需要恢复的既有文档才进入处理管道。
      const fileType = detectFileType(metadata.fileName);
      const task = opts.pipeline.createTask({
        documentId: claim.document.id,
        contentHash: metadata.hash,
        fileName: metadata.fileName,
        fileType,
        sourcePath: finalPath,
      });

      return { taskId: task.id, documentId: null as string | null, sourcePath: null as string | null, skipped: false };
    });

    // 清理上传临时分片，保留完成结果元数据以支持完成请求安全重试；
    // 元数据由现有的过期上传清理任务统一回收。
    await fs.rm(metadata.tempDir, { recursive: true, force: true }).catch(() => {});

    const completedResult = result.skipped
      ? {
          taskId: opts.pipeline.createCompletedTask({
            documentId: result.documentId!,
            fileName: metadata.fileName,
            sourcePath: result.sourcePath!,
            fileType: detectFileType(metadata.fileName),
          }).id,
          documentId: result.documentId!,
          dedup: true,
        }
      : { taskId: result.taskId! };

    await withUploadLock(metadata.id, async () => {
      const current = await loadUploadMetadata(metadata.id);
      if (!current) return;
      current.completedResult = completedResult;
      await saveUploadMetadata(current);
    });
    reply.send(completedResult);
  });

  // ---- GET /tasks/:id ----
  app.get("/tasks/:id", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    const task = opts.pipeline.getTask(params.id);
    if (!task) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.send(task);
  });

  // ---- GET /tasks/:id/text ----
  app.get("/tasks/:id/text", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    const task = opts.pipeline.getTask(params.id);
    if (!task) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    const textPages = (task.meta as any)?.textPages ?? [];
    reply.send({ taskId: task.id, pages: textPages });
  });

  // ---- GET /tasks/:id/layout ----
  app.get("/tasks/:id/layout", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    const task = opts.pipeline.getTask(params.id);
    if (!task) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    // 1️⃣ 内存 task.meta
    let layoutPages = (task.meta as any)?.layoutPages;
    // 2️⃣ 磁盘回退
    if ((!layoutPages || layoutPages.length === 0) && task.sourcePath) {
      const { loadPersistedLayout } = await import(
        "../../pipeline/ingestionPipeline.js"
      );
      const persisted = await loadPersistedLayout(task.sourcePath);
      if (persisted) {
        layoutPages = persisted;
        task.meta = { ...(task.meta || {}), layoutPages: persisted };
      }
    }
    reply.send({ taskId: task.id, pages: layoutPages ?? [] });
  });

  // ---- GET /files/:id ----
  app.get("/files/:id", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    const task = opts.pipeline.getTask(params.id);
    const index = task ? {} : await loadUploadIndex();
    const sourcePath = resolveDocumentSourcePath(params.id, task, Object.values(index));
    if (!sourcePath) {
      reply.code(404).send({ error: "file_source_not_found" });
      return;
    }
    try {
      await fs.access(sourcePath);
    } catch {
      reply.code(404).send({ error: "file_not_found_on_disk" });
      return;
    }
    const { createReadStream } = await import("fs");
    const stream = createReadStream(sourcePath);
    const fileType = task?.fileType ?? (await opts.prisma.document.findUnique({
      where: { id: params.id },
      select: { fileType: true },
    }))?.fileType ?? "pdf";
    reply.header("Content-Type", getContentType(fileType, sourcePath));
    return reply.send(stream);
  });
};
