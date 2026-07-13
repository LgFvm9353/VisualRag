import type { PrismaClient } from "@prisma/client";
import type { IngestionPipeline } from "../../../pipeline/ingestionPipeline.js";
import { loadUploadIndex } from "../../upload/upload.service.js";
import { loadPersistedLayout } from "../../../pipeline/ingestionPipeline.js";

export interface AgentContext {
  prisma: PrismaClient;
  pipeline: IngestionPipeline;
}

async function resolveDocumentSourcePath(ctx: AgentContext, documentId: string): Promise<string | null> {
  const task = ctx.pipeline.getTask(documentId);
  if (task?.sourcePath) return task.sourcePath;
  const index = await loadUploadIndex();
  for (const entry of Object.values(index) as Array<{ documentId: string; sourcePath: string }>) {
    if (entry.documentId === documentId) return entry.sourcePath;
  }
  return null;
}

export async function getSectionsTool(ctx: AgentContext, documentId: string) {
  const sections = await ctx.prisma.documentSection.findMany({
    where: { documentId },
    orderBy: { index: "asc" },
    select: {
      id: true,
      index: true,
      title: true,
      content: true,
      sourceType: true,
      pageNumber: true,
      headingLevel: true,
    },
  });

  return {
    summary: `读取 ${sections.length} 个文档段落/页面`,
    payload: sections,
  };
}

export async function getRegionsTool(ctx: AgentContext, documentId: string) {
  const sourcePath = await resolveDocumentSourcePath(ctx, documentId);
  const doc = await ctx.prisma.document.findUnique({
    where: { id: documentId },
    select: { fileType: true },
  });

  if (doc?.fileType && doc.fileType !== "pdf") {
    const sections = await ctx.prisma.documentSection.findMany({
      where: { documentId },
      orderBy: { index: "asc" },
      select: { index: true, headingLevel: true, content: true },
    });
    return {
      summary: `${doc?.fileType ?? "text"} 文档共 ${sections.length} 个可定位段落`,
      payload: sections.map((s) => ({
        pageNumber: s.index,
        width: 612,
        height: 792,
        regions: [],
        headingLevel: s.headingLevel,
        textSnippet: (s.content ?? "").slice(0, 200),
      })),
    };
  }

  const persisted = sourcePath ? await loadPersistedLayout(sourcePath) : null;
  if (persisted?.length) {
    return {
      summary: `PDF 文档共 ${persisted.length} 页布局数据`,
      payload: persisted.map((page: any) => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        regions: (page.regions ?? []).map((r: any) => ({
          id: r.id,
          pageNumber: r.pageNumber ?? page.pageNumber,
          type: r.type ?? "other",
          bbox: r.bbox,
          textSnippet: r.textSnippet ?? "",
        })),
      })),
    };
  }

  const fallback = await ctx.prisma.documentSection.findMany({
    where: { documentId },
    orderBy: { index: "asc" },
    select: { pageNumber: true, pageWidth: true, pageHeight: true },
  });

  return {
    summary: `PDF 文档布局缓存缺失，回退 ${fallback.length} 页基础尺寸数据`,
    payload: fallback
      .filter((s) => s.pageNumber != null)
      .map((s) => ({
        pageNumber: s.pageNumber!,
        width: s.pageWidth ?? 612,
        height: s.pageHeight ?? 792,
        regions: [],
      })),
  };
}
