import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { join } from "path";
import { pipeline as streamPipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { promises as fs } from "fs";
import type { IngestionPipeline } from "../../pipeline/ingestionPipeline.js";
import { uploadRateLimiter } from "../../server/plugins/rateLimit.js";
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
} from "./upload.service.js";

interface UploadPluginOptions {
  pipeline: IngestionPipeline;
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
    const existing = index[body.hash];
    if (existing?.sourcePath && existing?.documentId) {
      // 文件已存在且已入库 → 直接返回既有文档，不重新处理
      const task = opts.pipeline.createCompletedTask({
        documentId: existing.documentId,
        fileName: body.fileName,
      });
      reply.send({ fast: true, taskId: task.id, documentId: existing.documentId });
      return;
    }

    const existingId = body.existingUploadId;
    let uploadId: string | undefined = existingId;
    let metadata: Awaited<ReturnType<typeof loadUploadMetadata>> = null;
    if (existingId) {
      metadata = await withUploadLock(existingId, () => loadUploadMetadata(existingId));
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
        return { taskId: null as string | null, documentId: existing.documentId, skipped: true };
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

      // 创建处理任务
      const task = opts.pipeline.createTask({
        fileName: metadata.fileName,
        fileType: "pdf",
        sourcePath: finalPath,
      });

      // 写入 index（documentId = task.id，pipeline 里会用 task.id 作为 document.id）
      index[metadata.hash] = { sourcePath: finalPath, documentId: task.id };
      await saveUploadIndex(index);

      return { taskId: task.id, documentId: null as string | null, skipped: false };
    });

    // 清理上传临时文件（锁外操作）
    const chunksRootDir = getChunksRootDir();
    const metaPath = join(chunksRootDir, `${metadata.id}.json`);
    await fs.rm(metadata.tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(metaPath).catch(() => {});

    if (result.skipped) {
      const task = opts.pipeline.createCompletedTask({
        documentId: result.documentId!,
        fileName: metadata.fileName,
      });
      reply.send({ taskId: task.id, documentId: result.documentId!, dedup: true });
    } else {
      reply.send({ taskId: result.taskId! });
    }
  });

  // ---- POST /upload (legacy multipart) ----
  app.post("/upload", async (request, reply) => {
    await uploadRateLimiter(request.ip);
    try {
      const file = await (request as any).file();
      if (!file) {
        reply.code(400).send({ error: "file expected" });
        return;
      }
      const fileName = file.filename || "file";
      const uploadsDir = getUploadsDir();
      await fs.mkdir(uploadsDir, { recursive: true });

      // 先写临时文件，计算 hash 后做去重
      const tmpPath = join(uploadsDir, `tmp-${randomUUID()}`);
      const writeStream = createWriteStream(tmpPath);
      await streamPipeline(file.file, writeStream);

      // 计算文件 hash
      const { createHash } = await import("crypto");
      const fileData = await fs.readFile(tmpPath);
      const fileHash = createHash("sha256").update(fileData).digest("hex");

      // index 锁内做去重
      const result = await withIndexLock(async () => {
        const index = await loadUploadIndex();
        const existing = index[fileHash];
        if (existing?.documentId) {
          // 已有相同文件，删除临时文件
          await fs.unlink(tmpPath).catch(() => {});
          return { taskId: null as string | null, documentId: existing.documentId, skipped: true };
        }

        // 内容寻址：移动到 hash 文件名
        const finalPath = join(uploadsDir, fileHash);
        await fs.rename(tmpPath, finalPath);

        const task = opts.pipeline.createTask({
          fileName,
          fileType: "pdf",
          sourcePath: finalPath,
        });

        index[fileHash] = { sourcePath: finalPath, documentId: task.id };
        await saveUploadIndex(index);

        return { taskId: task.id, documentId: null as string | null, skipped: false };
      });

      if (result.skipped) {
        const task = opts.pipeline.createCompletedTask({
          documentId: result.documentId!,
          fileName,
        });
        reply.send({ taskId: task.id, documentId: result.documentId!, dedup: true });
      } else {
        reply.send({ taskId: result.taskId! });
      }
    } catch (err) {
      app.log.error({ err }, "Upload failed");
      reply.code(500).send({ error: "upload_failed" });
    }
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
    const layoutPages = (task.meta as any)?.layoutPages ?? [];
    reply.send({ taskId: task.id, pages: layoutPages });
  });

  // ---- GET /files/:id ----
  app.get("/files/:id", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    const task = opts.pipeline.getTask(params.id);
    if (!task) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    const { createReadStream } = await import("fs");
    const stream = createReadStream(task.sourcePath);
    reply.header("Content-Type", "application/pdf");
    return reply.send(stream);
  });
};
