import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { loadPersistedLayout } from "../../pipeline/ingestionPipeline.js";

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

    // 1️⃣ 优先从内存 task.meta 获取（pipeline 运行时最新数据，含 regions）
    let layoutPages: any[] | null = (task?.meta as any)?.layoutPages ?? null;

    // 2️⃣ 回退到磁盘持久化文件（服务重启后恢复，含 regions）
    if ((!layoutPages || layoutPages.length === 0) && task?.sourcePath) {
      layoutPages = await loadPersistedLayout(task.sourcePath);
      if (layoutPages && task) {
        // 回填内存，后续请求直接命中
        task.meta = { ...(task.meta || {}), layoutPages };
      }
    }

    // 3️⃣ 最后回退到 DB DocumentSection（仅 pageNumber/width/height，无 regions）
    if (!layoutPages || layoutPages.length === 0) {
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
