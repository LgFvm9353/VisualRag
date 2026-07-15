import { createWriteStream, createReadStream, promises as fs } from "fs";
import { join } from "path";
import { pipeline as streamPipeline } from "stream/promises";
import { randomUUID, createHash } from "crypto";

export interface UploadMetadata {
  id: string;
  fileName: string;
  fileSize: number;
  hash: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  tempDir: string;
  createdAt: string;
  completedResult?: {
    taskId: string;
    documentId?: string;
    dedup?: boolean;
  };
}

export interface UploadIndexEntry {
  sourcePath: string;
  documentId: string;
}

export type UploadIndex = Record<string, UploadIndexEntry>;

const uploadLocks = new Map<string, Promise<void>>();

/** 专门用于 upload-index.json 的锁 key */
const INDEX_LOCK_KEY = "__upload_index__";

/** 对 upload-index.json 的读写操作加锁，防止并发写损坏 */
export async function withIndexLock<T>(run: () => Promise<T>): Promise<T> {
  return withUploadLock(INDEX_LOCK_KEY, run);
}

export function getUploadsDir() {
  return join(process.cwd(), "uploads");
}
export function getChunksRootDir() {
  return join(getUploadsDir(), "chunks");
}
function metadataPath(rootDir: string, id: string) {
  return join(rootDir, `${id}.json`);
}

export async function withUploadLock<T>(uploadId: string, run: () => Promise<T>) {
  const prev = uploadLocks.get(uploadId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => next);
  uploadLocks.set(uploadId, tail);
  await prev;
  try {
    return await run();
  } finally {
    release();
    if (uploadLocks.get(uploadId) === tail) {
      uploadLocks.delete(uploadId);
    }
  }
}

export async function loadUploadIndex(): Promise<UploadIndex> {
  const indexPath = join(getUploadsDir(), "upload-index.json");
  try {
    const data = await fs.readFile(indexPath, "utf8");
    return JSON.parse(data) as UploadIndex;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

export async function saveUploadIndex(index: UploadIndex): Promise<void> {
  const dir = getUploadsDir();
  const indexPath = join(dir, "upload-index.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index), "utf8");
}

export async function loadUploadMetadata(id: string): Promise<UploadMetadata | null> {
  const rootDir = getChunksRootDir();
  const path = metadataPath(rootDir, id);
  try {
    const data = await fs.readFile(path, "utf8");
    return JSON.parse(data) as UploadMetadata;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveUploadMetadata(meta: UploadMetadata): Promise<void> {
  const rootDir = getChunksRootDir();
  await fs.mkdir(rootDir, { recursive: true });
  await fs.mkdir(meta.tempDir, { recursive: true });
  const path = metadataPath(rootDir, meta.id);
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(meta), "utf8");
  await fs.unlink(path).catch(() => {});
  await fs.rename(tmpPath, path);
}

export async function cleanupStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  const rootDir = getChunksRootDir();
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    const meta = await loadUploadMetadata(id);
    if (!meta) continue;
    const created = Date.parse(meta.createdAt);
    if (Number.isNaN(created) || now - created < maxAgeMs) continue;
    await fs.rm(meta.tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(metadataPath(rootDir, meta.id)).catch(() => {});
  }
}

export async function writeChunk(meta: UploadMetadata, index: number, data: Buffer): Promise<void> {
  const chunkPath = join(meta.tempDir, `${index}.part`);
  const writeStream = createWriteStream(chunkPath);
  await streamPipeline(
    (async function* () { yield data; })(),
    writeStream,
  );
}

export async function assembleFile(meta: UploadMetadata, finalPath: string): Promise<string> {
  const hash = createHash("sha256");
  for (let i = 0; i < meta.totalChunks; i++) {
    const chunkPath = join(meta.tempDir, `${i}.part`);
    const data = await fs.readFile(chunkPath);
    hash.update(data);
    await fs.appendFile(finalPath, data);
  }
  return hash.digest("hex");
}
