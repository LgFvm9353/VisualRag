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
    if (existing?.sourcePath) {
      const task = opts.pipeline.createTask({
        fileName: body.fileName,
        fileType: "pdf",
        sourcePath: existing.sourcePath,
      });
      reply.send({ fast: true, taskId: task.id });
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
    await withUploadLock(body.uploadId, async () => {
      const metadata = await loadUploadMetadata(body.uploadId);
      if (!metadata) {
        reply.code(404).send({ error: "upload_not_found" });
        return;
      }
      if (metadata.receivedChunks.length !== metadata.totalChunks) {
        reply.code(400).send({ error: "chunks_incomplete" });
        return;
      }
      const uploadsDir = getUploadsDir();
      await fs.mkdir(uploadsDir, { recursive: true });
      const finalPath = join(
        uploadsDir,
        `${Date.now()}-${metadata.fileName}`,
      );
      const digest = await assembleFile(metadata, finalPath);
      if (digest !== metadata.hash) {
        await fs.unlink(finalPath).catch(() => {});
        reply.code(400).send({ error: "hash_mismatch" });
        return;
      }
      const index = await loadUploadIndex();
      index[metadata.hash] = { sourcePath: finalPath };
      await saveUploadIndex(index);

      const userId = (request.headers["x-user-id"] as string) || "anonymous";
      const task = opts.pipeline.createTask({
        userId,
        fileName: metadata.fileName,
        fileType: "pdf",
        sourcePath: finalPath,
      });

      const chunksRootDir = getChunksRootDir();
      const metaPath = join(chunksRootDir, `${metadata.id}.json`);
      await fs
        .rm(metadata.tempDir, { recursive: true, force: true })
        .catch(() => {});
      await fs.unlink(metaPath).catch(() => {});

      reply.send({ taskId: task.id });
    });
  });

  // ---- POST /upload (legacy multipart) ----
  app.post("/upload", async (request, reply) => {
    await uploadRateLimiter(
      (request.headers["x-user-id"] as string) || request.ip,
    );
    try {
      const file = await (request as any).file();
      if (!file) {
        reply.code(400).send({ error: "file expected" });
        return;
      }
      const userId = (request.headers["x-user-id"] as string) || "anonymous";
      const fileName = file.filename || "file";
      const uploadsDir = getUploadsDir();
      await fs.mkdir(uploadsDir, { recursive: true });
      const filePath = join(uploadsDir, `${Date.now()}-${fileName}`);
      const writeStream = createWriteStream(filePath);
      await streamPipeline(file.file, writeStream);
      const task = opts.pipeline.createTask({
        userId,
        fileName,
        fileType: "pdf",
        sourcePath: filePath,
      });
      reply.send({ taskId: task.id });
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
