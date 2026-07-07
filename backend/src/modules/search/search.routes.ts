import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { semanticSearch } from "./search.service.js";

interface SearchPluginOptions {
  prisma: PrismaClient;
}

export const searchRoutes: FastifyPluginAsync<SearchPluginOptions> = async (
  app,
  opts,
) => {
  // ---- GET /documents/:id/search (keyword) ----
  app.get("/documents/:id/search", async (request, reply) => {
    const schema = z.object({
      id: z.string().uuid(),
      q: z.string().min(1),
    });
    const params = schema.parse({
      id: (request.params as any).id,
      q: (request.query as any).q,
    });
    const sections = await opts.prisma.documentSection.findMany({
      where: {
        documentId: params.id,
        content: { contains: params.q },
      },
      orderBy: { index: "asc" },
      take: 20,
    });
    const results = sections.map((s) => {
      const idx = s.content.toLowerCase().indexOf(params.q.toLowerCase());
      const window = 60;
      let snippet: string;
      if (idx === -1) {
        snippet = s.content.slice(0, window * 2);
      } else {
        const start = Math.max(0, idx - window);
        const end = Math.min(s.content.length, idx + params.q.length + window);
        snippet =
          (start > 0 ? "…" : "") +
          s.content.slice(start, end) +
          (end < s.content.length ? "…" : "");
      }
      return {
        documentId: params.id,
        pageNumber: s.pageNumber ?? s.index,
        snippet,
        regionIds: [] as string[],
      };
    });
    reply.send({ documentId: params.id, query: params.q, results });
  });

  // ---- GET /documents/:id/search/semantic ----
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
      const results = await semanticSearch(opts.prisma, params.id, params.q, params.limit);
      reply.send({ documentId: params.id, query: params.q, results });
    } catch (err) {
      app.log.error({ err }, "semantic_search_failed");
      reply.send({ documentId: params.id, query: params.q, results: [] });
    }
  });
};
