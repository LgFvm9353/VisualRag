import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

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

  // ---- GET /documents/:id/regions (layout data now served via /tasks/:id/layout) ----
  app.get("/documents/:id/regions", async (request, reply) => {
    const schema = z.object({ id: z.string().uuid() });
    const params = schema.parse(request.params);
    // Visual regions are no longer stored in DB; layout data is available
    // via GET /tasks/:id/layout during/after ingestion.
    reply.send({ documentId: params.id, pages: [] });
  });
};
