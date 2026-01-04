import fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import { createWriteStream, createReadStream, promises as fs } from "fs";
import { join } from "path";
import { pipeline as streamPipeline } from "stream/promises";
import { randomUUID, createHash } from "crypto";
import { IngestionPipeline } from "./pipeline/ingestionPipeline.js";
import { ProgressEmitter } from "./pipeline/progressEmitter.js";
import { prisma } from "./db/prisma.js";
import OpenAI from "openai";
import { ChatOpenAI } from "@langchain/openai";

function pickRegionIdsForText(
  pageNumber: number,
  text: string,
  query: string,
  regionsByPage: Map<number, string[]>
) {
  const regionIds = regionsByPage.get(pageNumber) ?? [];
  if (regionIds.length === 0) {
    return [];
  }
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const idx = textLower.indexOf(queryLower);
  if (idx === -1) {
    const middleIndex = Math.floor(regionIds.length / 2);
    return [regionIds[middleIndex]];
  }
  const before = text.slice(0, idx);
  const lineIndex = before.split("\n").length - 1;
  if (lineIndex < 0) {
    return [regionIds[0]];
  }
  const windowLines = 1;
  let startIndex = lineIndex - windowLines;
  let endIndex = lineIndex + windowLines;
  if (startIndex < 0) {
    startIndex = 0;
  }
  if (endIndex >= regionIds.length) {
    endIndex = regionIds.length - 1;
  }
  if (endIndex < startIndex) {
    endIndex = startIndex;
  }
  const selected = regionIds.slice(startIndex, endIndex + 1);
  return selected.length > 0 ? selected : [regionIds[startIndex]];
}

interface SemanticSearchResultItem {
  documentId: string;
  pageNumber: number;
  snippet: string;
  regionIds: string[];
}

interface UploadMetadata {
  id: string;
  fileName: string;
  fileSize: number;
  hash: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  tempDir: string;
  createdAt: string;
}

type UploadIndexEntry = {
  sourcePath: string;
};

type UploadIndex = Record<string, UploadIndexEntry>;

function getAllowedOrigins() {
  const value = process.env.FRONTEND_ORIGIN;
  if (!value) {
    return ["*"];
  }
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function resolveAllowedOrigin(origin: string | undefined) {
  const allowed = getAllowedOrigins();
  if (allowed.includes("*")) {
    return origin || "*";
  }
  if (!origin) {
    return undefined;
  }
  if (allowed.includes(origin)) {
    return origin;
  }
  return undefined;
}

function getUploadsDir() {
  return join(process.cwd(), "uploads");
}

function getChunksRootDir() {
  return join(getUploadsDir(), "chunks");
}

function getUploadMetadataPath(rootDir: string, id: string) {
  return join(rootDir, `${id}.json`);
}

async function loadUploadIndex(): Promise<UploadIndex> {
  const uploadsDir = getUploadsDir();
  const indexPath = join(uploadsDir, "upload-index.json");
  try {
    const data = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(data) as UploadIndex;
    return parsed;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function saveUploadIndex(index: UploadIndex): Promise<void> {
  const uploadsDir = getUploadsDir();
  const indexPath = join(uploadsDir, "upload-index.json");
  const json = JSON.stringify(index);
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(indexPath, json, "utf8");
}

async function loadUploadMetadata(
  id: string
): Promise<UploadMetadata | null> {
  const rootDir = getChunksRootDir();
  const path = getUploadMetadataPath(rootDir, id);
  try {
    const data = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(data) as UploadMetadata;
    return parsed;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function saveUploadMetadata(meta: UploadMetadata): Promise<void> {
  const rootDir = getChunksRootDir();
  await fs.mkdir(rootDir, { recursive: true });
  await fs.mkdir(meta.tempDir, { recursive: true });
  const path = getUploadMetadataPath(rootDir, meta.id);
  const json = JSON.stringify(meta);
  await fs.writeFile(path, json, "utf8");
}

async function cleanupStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  const rootDir = getChunksRootDir();
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const id = entry.slice(0, -5);
    const meta = await loadUploadMetadata(id);
    if (!meta) {
      continue;
    }
    const created = Date.parse(meta.createdAt);
    if (Number.isNaN(created)) {
      continue;
    }
    if (now - created < maxAgeMs) {
      continue;
    }
    const metadataPath = getUploadMetadataPath(rootDir, meta.id);
    await fs.rm(meta.tempDir, { recursive: true, force: true }).catch(
      () => {}
    );
    await fs.unlink(metadataPath).catch(() => {});
  }
}

const app = fastify({ logger: true });

app.addContentTypeParser(
  "application/octet-stream",
  (_request, payload, done) => {
    done(null, payload);
  }
);

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

const embeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL || "embedding-2";

const chatModel = process.env.OPENAI_CHAT_MODEL || "glm-4-flash";

const chatLlm = new ChatOpenAI({
  model: chatModel,
  streaming: true,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  },
});

async function semanticSearch(
  documentId: string,
  query: string,
  limit?: number
): Promise<SemanticSearchResultItem[]> {
  const effectiveLimit = limit ?? 10;
  async function buildResultsFromTextPages(
    matches: {
      pageNumber: number;
      text: string;
    }[]
  ): Promise<SemanticSearchResultItem[]> {
    if (matches.length === 0) {
      return [];
    }
    const pageNumbers = Array.from(
      new Set(matches.map((m) => m.pageNumber))
    ) as number[];
    const regions = await prisma.visualRegion.findMany({
      where: {
        documentId,
        pageNumber: { in: pageNumbers },
      },
      orderBy: [{ pageNumber: "asc" }, { y0: "asc" }],
    });
    const regionsByPage = new Map<number, string[]>();
    for (const r of regions) {
      const list = regionsByPage.get(r.pageNumber) ?? [];
      list.push(r.id);
      regionsByPage.set(r.pageNumber, list);
    }
    const results = matches.map((m) => {
      const text = m.text;
      const queryLower = query.toLowerCase();
      const textLower = text.toLowerCase();
      const idx = textLower.indexOf(queryLower);
      const window = 60;
      let snippet: string;
      if (idx === -1) {
        snippet = text.slice(0, window * 2);
      } else {
        const start = Math.max(0, idx - window);
        const end = Math.min(text.length, idx + query.length + window);
        snippet =
          (start > 0 ? "…" : "") +
          text.slice(start, end) +
          (end < text.length ? "…" : "");
      }
      const regionIds = pickRegionIdsForText(
        m.pageNumber,
        text,
        query,
        regionsByPage
      );
      return {
        documentId,
        pageNumber: m.pageNumber,
        snippet,
        regionIds,
      };
    });
    return results;
  }
  const keywordMatches = await prisma.textPage.findMany({
    where: {
      documentId,
      text: {
        contains: query,
      },
    },
    orderBy: { pageNumber: "asc" },
    take: effectiveLimit,
  });
  if (keywordMatches.length > 0) {
    return buildResultsFromTextPages(keywordMatches);
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("embedding_model_not_configured");
  }
  const embeddingResponse = await openai.embeddings.create({
    model: embeddingModel,
    input: query,
  });
  const embedding = embeddingResponse.data[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    const matches = await prisma.textPage.findMany({
      where: {
        documentId,
        text: {
          contains: query,
        },
      },
      orderBy: { pageNumber: "asc" },
      take: effectiveLimit,
    });
    return buildResultsFromTextPages(matches);
  }
  const embeddingLiteral = `[${embedding.join(",")}]`;
  const rows = await prisma.$queryRaw<
    {
      textPageId: string;
      pageNumber: number;
      text: string;
      similarity: number;
    }[]
  >`
    SELECT
      tp.id as "textPageId",
      tp."pageNumber" as "pageNumber",
      tp."text" as "text",
      1 - (te."embedding" <=> ${embeddingLiteral}::vector) as "similarity"
    FROM "TextEmbedding" te
    JOIN "TextPage" tp ON tp.id = te."textPageId"
    WHERE te."documentId" = ${documentId}
    ORDER BY "similarity" DESC
    LIMIT ${effectiveLimit};
  `;
  if (rows.length === 0) {
    const matches = await prisma.textPage.findMany({
      where: {
        documentId,
        text: {
          contains: query,
        },
      },
      orderBy: { pageNumber: "asc" },
      take: effectiveLimit,
    });
    return buildResultsFromTextPages(matches);
  }
  const pageNumbers = Array.from(
    new Set(rows.map((r) => r.pageNumber))
  ) as number[];
  const regions = await prisma.visualRegion.findMany({
    where: {
      documentId,
      pageNumber: { in: pageNumbers },
    },
    orderBy: [{ pageNumber: "asc" }, { y0: "asc" }],
  });
  const regionsByPage = new Map<number, string[]>();
  for (const r of regions) {
    const list = regionsByPage.get(r.pageNumber) ?? [];
    list.push(r.id);
    regionsByPage.set(r.pageNumber, list);
  }
  const results = rows.map((row) => {
    const text = row.text;
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();
    const idx = textLower.indexOf(queryLower);
    const window = 60;
    let snippet: string;
    if (idx === -1) {
      snippet = text.slice(0, window * 2);
    } else {
      const start = Math.max(0, idx - window);
      const end = Math.min(text.length, idx + query.length + window);
      snippet =
        (start > 0 ? "…" : "") +
        text.slice(start, end) +
        (end < text.length ? "…" : "");
    }
    const regionIds = pickRegionIdsForText(
      row.pageNumber,
      text,
      query,
      regionsByPage
    );
    return {
      documentId,
      pageNumber: row.pageNumber,
      snippet,
      regionIds,
    };
  });
  return results;
}

app.register(cors, {
  origin(origin, cb) {
    if (!origin) {
      cb(null, true);
      return;
    }
    const resolved = resolveAllowedOrigin(origin);
    if (!resolved) {
      cb(new Error("Origin not allowed"), false);
      return;
    }
    cb(null, true);
  },
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-user-id"],
  credentials: !getAllowedOrigins().includes("*"),
});

app.register(multipart);

const io = new SocketIOServer(app.server, {
  cors: {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const resolved = resolveAllowedOrigin(origin);
      if (!resolved) {
        callback(new Error("Origin not allowed"), false as any);
        return;
      }
      callback(null, true);
    },
  },
});

const progressEmitter = new ProgressEmitter(io);
const pipeline = new IngestionPipeline(progressEmitter);

app.post("/upload/init", async (request, reply) => {
  const schema = z.object({
    fileName: z.string().min(1),
    fileSize: z.number().int().min(1),
    hash: z.string().min(1),
    chunkSize: z.number().int().min(1),
    existingUploadId: z.string().uuid().optional(),
  });
  const body = schema.parse(request.body);
  const uploadsDir = getUploadsDir();
  const chunksRootDir = getChunksRootDir();
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(chunksRootDir, { recursive: true });
  const index = await loadUploadIndex();
  const existing = index[body.hash];
  if (existing && existing.sourcePath) {
    const userId = (request.headers["x-user-id"] as string) || "anonymous";
    const task = pipeline.createTask({
      userId,
      fileName: body.fileName,
      fileType: "pdf",
      sourcePath: existing.sourcePath,
    });
    reply.send({ fast: true, taskId: task.id });
    return;
  }
  let uploadId = body.existingUploadId;
  let metadata: UploadMetadata | null = null;
  if (uploadId) {
    metadata = await loadUploadMetadata(uploadId);
  }
  if (!metadata) {
    const totalChunks = Math.ceil(body.fileSize / body.chunkSize);
    const tempDir = join(chunksRootDir, randomUUID());
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

app.put("/upload/chunk", async (request, reply) => {
  const schema = z.object({
    uploadId: z.string().uuid(),
    index: z.coerce.number().int().min(0),
  });
  const params = schema.parse(request.query as any);
  const metadata = await loadUploadMetadata(params.uploadId);
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
    const payload = request.body as any;
    await streamPipeline(payload, writeStream);
  } catch (err) {
    await fs.unlink(chunkPath).catch(() => {});
    throw err;
  }
  if (!metadata.receivedChunks.includes(params.index)) {
    metadata.receivedChunks.push(params.index);
    metadata.receivedChunks.sort((a, b) => a - b);
    await saveUploadMetadata(metadata);
  }
  reply.send({ ok: true });
});

app.post("/upload/complete", async (request, reply) => {
  const schema = z.object({
    uploadId: z.string().uuid(),
  });
  const body = schema.parse(request.body);
  const uploadsDir = getUploadsDir();
  const chunksRootDir = getChunksRootDir();
  const metadata = await loadUploadMetadata(body.uploadId);
  if (!metadata) {
    reply.code(404).send({ error: "upload_not_found" });
    return;
  }
  if (metadata.receivedChunks.length !== metadata.totalChunks) {
    reply.code(400).send({ error: "chunks_incomplete" });
    return;
  }
  await fs.mkdir(uploadsDir, { recursive: true });
  const finalPath = join(uploadsDir, `${Date.now()}-${metadata.fileName}`);
  const hash = createHash("sha256");
  for (let index = 0; index < metadata.totalChunks; index++) {
    const chunkPath = join(metadata.tempDir, `${index}.part`);
    const data = await fs.readFile(chunkPath);
    hash.update(data);
    await fs.appendFile(finalPath, data);
  }
  const digest = hash.digest("hex");
  if (digest !== metadata.hash) {
    await fs.unlink(finalPath).catch(() => {});
    reply.code(400).send({ error: "hash_mismatch" });
    return;
  }
  const index = await loadUploadIndex();
  index[metadata.hash] = { sourcePath: finalPath };
  await saveUploadIndex(index);
  const userId = (request.headers["x-user-id"] as string) || "anonymous";
  const task = pipeline.createTask({
    userId,
    fileName: metadata.fileName,
    fileType: "pdf",
    sourcePath: finalPath,
  });
  const metadataPath = getUploadMetadataPath(chunksRootDir, metadata.id);
  await fs.rm(metadata.tempDir, { recursive: true, force: true }).catch(
    () => {}
  );
  await fs.unlink(metadataPath).catch(() => {});
  reply.send({ taskId: task.id });
});

app.post("/upload", async (request, reply) => {
  try {
    app.log.info("Upload request received");
    const file = await (request as any).file();
    if (!file) {
      reply.code(400).send({ error: "file expected" });
      return;
    }
    const userId = (request.headers["x-user-id"] as string) || "anonymous";
    const fileName = file.filename || "file";
    const uploadDir = join(process.cwd(), "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const filePath = join(uploadDir, `${Date.now()}-${fileName}`);
    const writeStream = createWriteStream(filePath);
    await streamPipeline(file.file, writeStream);
    const task = pipeline.createTask({
      userId,
      fileName,
      fileType: "pdf",
      sourcePath: filePath,
    });
    app.log.info({ taskId: task.id }, "Upload handled successfully");
    reply.send({ taskId: task.id });
  } catch (err) {
    app.log.error({ err }, "Upload failed");
    reply.code(500).send({ error: "upload_failed" });
  }
});

app.get("/tasks/:id", async (request, reply) => {
  const schema = z.object({ id: z.string().uuid() });
  const params = schema.parse(request.params);
  const task = pipeline.getTask(params.id);
  if (!task) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  reply.send(task);
});

app.get("/tasks/:id/text", async (request, reply) => {
  const schema = z.object({ id: z.string().uuid() });
  const params = schema.parse(request.params);
  const task = pipeline.getTask(params.id);
  if (!task) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const textPages = (task.meta as any)?.textPages ?? [];
  reply.send({ taskId: task.id, pages: textPages });
});

app.get("/tasks/:id/layout", async (request, reply) => {
  const schema = z.object({ id: z.string().uuid() });
  const params = schema.parse(request.params);
  const task = pipeline.getTask(params.id);
  if (!task) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const layoutPages = (task.meta as any)?.layoutPages ?? [];
  reply.send({ taskId: task.id, pages: layoutPages });
});

app.get("/files/:id", async (request, reply) => {
  const schema = z.object({ id: z.string().uuid() });
  const params = schema.parse(request.params);
  const task = pipeline.getTask(params.id);
  if (!task) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const stream = createReadStream(task.sourcePath);
  reply.header("Content-Type", "application/pdf");
  return reply.send(stream);
});

app.get("/documents/:id/text", async (request, reply) => {
  const schema = z.object({ id: z.string().uuid() });
  const params = schema.parse(request.params);
  const pages = await prisma.textPage.findMany({
    where: { documentId: params.id },
    orderBy: { pageNumber: "asc" },
  });
  reply.send({ documentId: params.id, pages });
});

app.get("/documents/:id/regions", async (request, reply) => {
  const schema = z.object({ id: z.string().uuid() });
  const params = schema.parse(request.params);
  const pages = await prisma.page.findMany({
    where: { documentId: params.id },
    orderBy: { pageNumber: "asc" },
  });
  const regions = await prisma.visualRegion.findMany({
    where: { documentId: params.id },
    orderBy: [{ pageNumber: "asc" }, { y0: "asc" }],
  });
  const regionsByPage = new Map<number, typeof regions>();
  for (const region of regions) {
    const list = regionsByPage.get(region.pageNumber) ?? [];
    list.push(region);
    regionsByPage.set(region.pageNumber, list);
  }
  const resultPages = pages.map((p) => ({
    pageNumber: p.pageNumber,
    width: p.width,
    height: p.height,
    regions: (regionsByPage.get(p.pageNumber) ?? []).map((r) => ({
      id: r.id,
      pageNumber: r.pageNumber,
      type: r.type,
      bbox: {
        x0: r.x0,
        y0: r.y0,
        x1: r.x1,
        y1: r.y1,
      },
    })),
  }));
  reply.send({ documentId: params.id, pages: resultPages });
});

app.get("/documents/:id/search", async (request, reply) => {
  const schema = z.object({
    id: z.string().uuid(),
    q: z.string().min(1),
  });
  const params = schema.parse({
    id: (request.params as any).id,
    q: (request.query as any).q,
  });
  const matches = await prisma.textPage.findMany({
    where: {
      documentId: params.id,
      text: {
        contains: params.q,
      },
    },
    orderBy: { pageNumber: "asc" },
    take: 20,
  });
  if (matches.length === 0) {
    reply.send({ documentId: params.id, query: params.q, results: [] });
    return;
  }
  const pageNumbers = Array.from(
    new Set(matches.map((m) => m.pageNumber))
  ) as number[];
  const regions = await prisma.visualRegion.findMany({
    where: {
      documentId: params.id,
      pageNumber: { in: pageNumbers },
    },
    orderBy: [{ pageNumber: "asc" }, { y0: "asc" }],
  });
  const regionsByPage = new Map<number, string[]>();
  for (const r of regions) {
    const list = regionsByPage.get(r.pageNumber) ?? [];
    list.push(r.id);
    regionsByPage.set(r.pageNumber, list);
  }
  const results = matches.map((m) => {
    const text = m.text;
    const queryLower = params.q.toLowerCase();
    const textLower = text.toLowerCase();
    const idx = textLower.indexOf(queryLower);
    const window = 60;
    let snippet: string;
    if (idx === -1) {
      snippet = text.slice(0, window * 2);
    } else {
      const start = Math.max(0, idx - window);
      const end = Math.min(text.length, idx + params.q.length + window);
      snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    }
    const regionIds = pickRegionIdsForText(
      m.pageNumber,
      text,
      params.q,
      regionsByPage
    );
    return {
      documentId: params.id,
      pageNumber: m.pageNumber,
      snippet,
      regionIds,
    };
  });
  reply.send({ documentId: params.id, query: params.q, results });
});

app.get("/documents/:id/search/semantic", async (request, reply) => {
  const schema = z.object({
    id: z.string().uuid(),
    q: z.string().min(1),
    limit: z.coerce.number().min(1).max(50).optional(),
  });
  const params = schema.parse({
    id: (request.params as any).id,
    q: (request.query as any).q,
    limit: (request.query as any).limit,
  });
  try {
    const results = await semanticSearch(params.id, params.q, params.limit);
    reply.send({ documentId: params.id, query: params.q, results });
  } catch (err) {
    app.log.error({ err }, "semantic_search_failed");
    reply.send({ documentId: params.id, query: params.q, results: [] });
  }
});

app.get("/chat/stream", async (request, reply) => {
  const schema = z.object({
    documentId: z.string().uuid(),
    q: z.string().min(1),
    limit: z.coerce.number().min(1).max(20).optional(),
  });
  const params = schema.parse({
    documentId: (request.query as any).documentId,
    q: (request.query as any).q,
    limit: (request.query as any).limit,
  });
  const originHeader = resolveAllowedOrigin(
    request.headers.origin as string | undefined
  );
  if (!originHeader) {
    reply.code(403).send({ error: "origin_not_allowed" });
    return;
  }
  const req = request.raw;
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": originHeader,
  });
  reply.raw.flushHeaders?.();
  try {
    const results = await semanticSearch(params.documentId, params.q, params.limit);
    const contextPieces = results.map(
      (r, index) =>
        `Passage ${index + 1} (page ${r.pageNumber}):\n${r.snippet}`
    );
    const systemPrompt =
      "你是一个文档问答助手，只能基于提供的文档片段回答问题。如果文档中没有相关信息，请明确说明无法从文档中回答。回答时用中文简要、清晰地总结要点。";
    const contextText =
      contextPieces.length > 0
        ? contextPieces.join("\n\n")
        : "没有检索到与问题相关的文档片段。";
    const prompt = [
      "系统指令：",
      systemPrompt,
      "",
      `问题：${params.q}`,
      "",
      "文档片段：",
      contextText,
    ].join("\n");
    const stream = await chatLlm.stream(prompt);
    for await (const chunk of stream) {
      if (closed) {
        break;
      }
      const content = chunk.content;
      const token =
        typeof content === "string"
          ? content
          : Array.isArray(content) && content.length > 0
          ? (content[0] as any)?.text ?? ""
          : "";
      if (token) {
        const payload = JSON.stringify({ type: "token", token });
        reply.raw.write(`data: ${payload}\n\n`);
      }
    }
    if (closed) {
      return reply;
    }
    const citations = results.map((r) => ({
      pageNumber: r.pageNumber,
      regionIds: r.regionIds,
    }));
    const donePayload = JSON.stringify({ type: "done", citations });
    reply.raw.write(`data: ${donePayload}\n\n`);
    reply.raw.end();
  } catch (err: any) {
    app.log.error({ err }, "chat_stream_failed");
    const message =
      err?.error?.message ||
      err?.response?.data?.message ||
      err?.message ||
      "unknown_error";
    if (!reply.raw.writableEnded) {
      const payload = JSON.stringify({ type: "error", message });
      reply.raw.write(`data: ${payload}\n\n`);
      reply.raw.end();
    }
  }
  return reply;
});

app.get("/health", async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    reply.send({ status: "ok" });
  } catch (err: any) {
    app.log.error({ err }, "health_check_failed");
    reply.code(500).send({ status: "error" });
  }
});

io.on("connection", (socket) => {
  socket.on("join-task", (taskId: string) => {
    progressEmitter.joinRoom(taskId, socket.id);
  });
});

const port = Number(process.env.PORT) || 4000;

const start = async () => {
  try {
    void cleanupStaleUploads();
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`VisualRAG Insight backend running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
