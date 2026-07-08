import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../../config/env.js";
import { chatRateLimiter } from "../../server/plugins/rateLimit.js";
import type { PrismaClient } from "@prisma/client";
import type { IngestionPipeline } from "../../pipeline/ingestionPipeline.js";
import { HybridSearchService } from "../search/retrieval/hybrid-search.service.js";
import { LLMReranker } from "../search/retrieval/reranker.service.js";
import { CragService } from "../search/retrieval/crag.service.js";
import { buildChatGraph } from "./graph.js";

interface ChatPluginOptions {
  prisma: PrismaClient;
  pipeline: IngestionPipeline;
}

export const chatRoutes: FastifyPluginAsync<ChatPluginOptions> = async (app, opts) => {
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

    const clientIp = request.ip;
    await chatRateLimiter(clientIp);

    const allowed = config.allowedOrigins;
    const origin = request.headers.origin as string | undefined;
    if (!allowed.includes("*") && origin && !allowed.includes(origin)) {
      reply.code(403).send({ error: "origin_not_allowed" });
      return;
    }

    const req = request.raw;
    let closed = false;
    req.on("close", () => { closed = true; });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": origin || "*",
    });
    reply.raw.flushHeaders?.();

    const savedCitations: unknown[] = [];

    function emit(payload: Record<string, unknown>) {
      if (closed || reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    try {
      const reranker = new LLMReranker();
      const hybridSearch = new HybridSearchService(opts.prisma, reranker);
      const cragService = new CragService();
      const graph = buildChatGraph(hybridSearch, cragService, opts.prisma);

      emit({ type: "status", status: "classifying_intent" });

      // 流式 writer：LLM 每生成一个 token 就实时推送给前端
      const writer = (token: string) => {
        if (!closed && !reply.raw.writableEnded) {
          emit({ type: "token", token });
        }
      };

      for await (const update of await graph.stream(
        {
          query: params.q,
          documentId: params.documentId,
          conversationHistory: [],
          iterationCount: 0,
        } as any,
        { configurable: { writer } },
      )) {
        if (closed) break;

        if (update.classifyIntent) {
          emit({ type: "intent", intent: (update.classifyIntent as any).intent });
        }

        if (update.retrieveContext) {
          const ctx = update.retrieveContext as any;
          if (ctx.citations) {
            savedCitations.push(...ctx.citations);
          }
          emit({ type: "retrieved", count: ctx.citations?.length ?? 0 });
        }

        if (update.generateAnswer) {
          const answer = update.generateAnswer as any;
          if (answer.finished) {
            emit({ type: "done", citations: savedCitations });
            break;
          }
        }
      }

      if (!closed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    } catch (err: any) {
      app.log.error({ err }, "chat_stream_failed");
      const message =
        err?.error?.message || err?.response?.data?.message || err?.message || "unknown_error";
      if (!reply.raw.writableEnded) {
        emit({ type: "error", message });
        reply.raw.end();
      }
    }

    return reply;
  });
};
