import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { loadPersistedLayout } from "../../pipeline/ingestionPipeline.js";
import { loadUploadIndex } from "../upload/upload.service.js";
import { analyzePdfLayout } from "../../pdf/layoutAnalyzer.js";
import { writeFile } from "fs/promises";

interface DocumentPluginOptions {
  prisma: PrismaClient;
  pipeline?: any;
}

export const documentRoutes: FastifyPluginAsync<DocumentPluginOptions> = async (
  app,
  opts,
) => {
  // ---- GET /documents/:id/sections ----
  app.get("/documents/:id/sections", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    const sections = await opts.prisma.documentSection.findMany({
      where: { documentId: params.id },
      orderBy: { index: "asc" },
    });
    reply.send({ documentId: params.id, sections });
  });

  // ---- GET /documents/:id/regions ----
  app.get("/documents/:id/regions", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);

    const task = opts.pipeline?.getTask(params.id);
    console.log("[regions] documentId:", params.id, "task in memory:", !!task);

    // 1️⃣ 优先从内存 task.meta 获取（pipeline 运行时最新数据，含 regions）
    let layoutPages: any[] | null = (task?.meta as any)?.layoutPages ?? null;
    console.log("[regions] step1 memory layoutPages:", layoutPages?.length ?? 0, "pages");

    // 尝试获取 sourcePath：优先 task，回退到 UploadIndex
    let sourcePath = task?.sourcePath ?? null;
    if (!sourcePath) {
      console.log("[regions] task.sourcePath is null, trying UploadIndex...");
      // 服务重启后 task 不在内存中，通过 UploadIndex 查找 sourcePath
      const index = await loadUploadIndex();
      for (const entry of Object.values(index)) {
        if (entry.documentId === params.id) {
          sourcePath = entry.sourcePath;
          break;
        }
      }
      console.log("[regions] UploadIndex sourcePath:", sourcePath ?? "NOT FOUND");
    } else {
      console.log("[regions] task.sourcePath:", sourcePath);
    }

    // 2️⃣ 回退到磁盘持久化文件（服务重启后恢复 / dedup 上传，含 regions）
    if ((!layoutPages || layoutPages.length === 0) && sourcePath) {
      console.log("[regions] step2 loading from disk:", sourcePath + ".layout.json");
      layoutPages = await loadPersistedLayout(sourcePath);
      console.log("[regions] step2 disk result:", layoutPages ? `${layoutPages.length} pages, ${layoutPages[0]?.regions?.length ?? 0} regions on page1` : "NULL");
      if (layoutPages && task) {
        // 回填内存，后续请求直接命中
        task.meta = { ...(task.meta || {}), layoutPages };
      }
    } else {
      console.log("[regions] step2 skipped: hasLayout=", !(!layoutPages || layoutPages.length === 0), "hasSourcePath=", !!sourcePath);
    }

    // 2b️⃣ 磁盘无缓存时，异步触发 layout 分析（不阻塞本次请求）
    if ((!layoutPages || layoutPages.length === 0) && sourcePath) {
      console.log("[regions] step2b async trigger layout analysis on:", sourcePath);
      const sp = sourcePath;
      const t = task;
      analyzePdfLayout(sp, params.id)
        .then(async (pages) => {
          console.log("[regions] step2b async layout done:", pages.length, "pages");
          const layoutPath = sp + ".layout.json";
          await writeFile(layoutPath, JSON.stringify(pages), "utf8");
          console.log("[regions] step2b async persisted to", layoutPath);
          if (t) {
            t.meta = { ...(t.meta || {}), layoutPages: pages };
          }
        })
        .catch((err) => {
          console.error("[regions] step2b async layout analysis failed:", err);
        });
    }

    // 3️⃣ 最后回退到 DB DocumentSection（仅 pageNumber/width/height，无 regions）
    if (!layoutPages || layoutPages.length === 0) {
      console.log("[regions] step3 DB fallback");
      const sections = await opts.prisma.documentSection.findMany({
        where: { documentId: params.id },
        orderBy: { index: "asc" },
        select: {
          pageNumber: true,
          pageWidth: true,
          pageHeight: true,
        },
      });
      if (sections.length > 0) {
        layoutPages = sections
          .filter((s) => s.pageNumber != null)
          .map((s) => ({
            pageNumber: s.pageNumber!,
            width: s.pageWidth ?? 612,
            height: s.pageHeight ?? 792,
            regions: [],
          }));
      }
    }

    const pages = (layoutPages ?? []).map((p: any) => ({
      pageNumber: p.pageNumber,
      width: p.width,
      height: p.height,
      regions: (p.regions ?? []).map((r: any) => ({
        id: r.id,
        pageNumber: r.pageNumber ?? p.pageNumber,
        type: r.type ?? "other",
        bbox: r.bbox,
      })),
    }));

    reply.send({ documentId: params.id, pages });
  });
};
