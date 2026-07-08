import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  loadPersistedLayout,
  loadPersistedDocxHtml,
} from "../../pipeline/ingestionPipeline.js";
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

    // 判断是否为 Word 文档（Word 无 PDF layout 分析，从 DB 读取段落信息）
    const docType =
      task?.fileType ??
      (await opts.prisma.document
        .findUnique({ where: { id: params.id }, select: { fileType: true } })
        .then((d) => d?.fileType)) ??
      "pdf";
    const isDocx = docType === "docx";

    // Word 文档：从 DB 读取段落信息，每个段落映射为一个"page"
    if (isDocx) {
      const sections = await opts.prisma.documentSection.findMany({
        where: { documentId: params.id },
        orderBy: { index: "asc" },
        select: {
          index: true,
          headingLevel: true,
          content: true,
        },
      });
      const pages = sections.map((s) => ({
        pageNumber: s.index,
        width: 612,
        height: 792,
        regions: [],
        headingLevel: s.headingLevel,
        textSnippet: (s.content ?? "").slice(0, 200),
      }));
      reply.send({ documentId: params.id, pages });
      return;
    }

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
        textSnippet: r.textSnippet ?? "",
      })),
    }));

    reply.send({ documentId: params.id, pages });
  });

  // ---- GET /documents/:id/html (Word 文档 HTML 内容) ----
  app.get("/documents/:id/html", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);

    // 1️⃣ 优先从内存 task.meta 获取（pipeline 运行期间）
    const task = opts.pipeline?.getTask(params.id);
    let html: string | null = (task?.meta as any)?.docxHtml ?? null;

    // 2️⃣ 回退到磁盘持久化文件（服务重启后恢复）
    if (!html) {
      let sourcePath = task?.sourcePath ?? null;
      if (!sourcePath) {
        const index = await loadUploadIndex();
        for (const entry of Object.values(index)) {
          if (entry.documentId === params.id) {
            sourcePath = entry.sourcePath;
            break;
          }
        }
      }
      if (sourcePath) {
        html = await loadPersistedDocxHtml(sourcePath);
        // 回填到内存
        if (html && task) {
          task.meta = { ...(task.meta || {}), docxHtml: html };
        }
      }

      // 3️⃣ 磁盘无缓存但源文件存在时，实时重新解析（兜底）
      // 必须确认是 Word 文档才调用 mammoth（否则 JSZip 会在非 ZIP 文件上报错）
      if (!html && sourcePath) {
        // 查询 DB 确认文档类型
        let fileType: string | null = null;
        try {
          const doc = await opts.prisma.document.findUnique({
            where: { id: params.id },
            select: { fileType: true },
          });
          fileType = doc?.fileType ?? null;
        } catch {
          // DB 查询失败，跳过
        }
        if (fileType === "docx") {
          try {
            const { extractTextFromDocx } = await import(
              "../../docx/textExtractor.js"
            );
            const result = await extractTextFromDocx(sourcePath);
            html = result.html;
            // 异步持久化（不阻塞响应）
            if (html) {
              const htmlPath = sourcePath + ".docx.html";
              const { writeFile } = await import("fs/promises");
              writeFile(htmlPath, html, "utf8").catch((err) =>
                console.error("[html] persist fallback failed:", err),
              );
              if (task) {
                task.meta = { ...(task.meta || {}), docxHtml: html };
              }
            }
          } catch (err) {
            console.error("[html] re-extract fallback failed:", err);
          }
        } else {
          console.warn(
            "[html] document is not docx (fileType=%s), skipping re-extract for %s",
            fileType ?? "unknown",
            sourcePath,
          );
        }
      }
    }

    if (!html) {
      reply.code(404).send({ error: "html_not_found" });
      return;
    }

    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.send(html);
  });
};
