import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { z } from "zod";
import type { IngestionPipeline } from "../../pipeline/ingestionPipeline.js";
import { AgentRuntime } from "./runtime.js";
import {
  createAgentMessageSchema,
  createAgentSessionSchema,
  runAgentTaskSchema,
} from "./types.js";
import { logAgentRunStart } from "./trace.js";
import { askKnowledgeBaseSchema } from "../knowledge-base/knowledge-base.types.js";
import { config } from "../../config/env.js";
import { OpenAICompatibleChatGateway } from "./model/chat-model.gateway.js";
import { IntentRouter } from "./intent/intent-router.js";
import { ConversationQueryResolver } from "./conversation/conversation-query-resolver.js";
import { RetrievalRetryPlanner } from "./retrieval/retry-planner.js";
import { KnowledgeBaseSearchTool } from "./tools/knowledge-base-search.tool.js";
import { HybridSearchService } from "../search/retrieval/hybrid-search.service.js";
import { LLMReranker } from "../search/retrieval/reranker.service.js";
import { GroundedAnswerGenerator } from "./answer/grounded-answer.generator.js";
import { KnowledgeBaseAgentGraph } from "./graph/knowledge-base-agent.graph.js";
import { KnowledgeBaseAgentService } from "./knowledge-base-agent.service.js";
import { SseWriter } from "./stream/sse-writer.js";

interface AgentRoutesOptions {
  prisma: PrismaClient;
  pipeline: IngestionPipeline;
}

const sessionParamsSchema = z.object({ id: z.string().uuid() });

export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, opts) => {
  const runtime = new AgentRuntime({ prisma: opts.prisma, pipeline: opts.pipeline });
  const chatGateway = new OpenAICompatibleChatGateway(new OpenAI({
    baseURL: config.chat.baseURL,
    apiKey: config.chat.apiKey,
  }), config.chat.model);
  const knowledgeBaseAgent = new KnowledgeBaseAgentService(
    opts.prisma,
    new KnowledgeBaseAgentGraph({
      intentRouter: new IntentRouter(chatGateway),
      queryResolver: new ConversationQueryResolver(chatGateway),
      searchTool: new KnowledgeBaseSearchTool(new HybridSearchService(opts.prisma, new LLMReranker())),
      retryPlanner: new RetrievalRetryPlanner(chatGateway),
      answerGenerator: new GroundedAnswerGenerator(chatGateway),
    }),
  );

  app.post("/knowledge-base/ask", async (request, reply) => {
    const input = askKnowledgeBaseSchema.parse(request.body ?? {});
    const trace = {
      traceId: String(request.id),
      startedAt: new Date().toISOString(),
    };
    const result = await runtime.askKnowledgeBase(input, trace);
    reply.send(result);
  });

  app.get("/knowledge-base/documents", async (_request, reply) => {
    const documents = await opts.prisma.document.findMany({
      where: { status: "ready" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fileName: true,
        fileType: true,
        sourceLabel: true,
        publishedAt: true,
        tags: true,
        createdAt: true,
      },
    });
    reply.send({ documents });
  });

  app.post("/agent/sessions", async (request, reply) => {
    const input = createAgentSessionSchema.parse(request.body ?? {});
    if (input.documentId) {
      const doc = await opts.prisma.document.findUnique({
        where: { id: input.documentId },
        select: { id: true },
      });
      if (!doc) {
        reply.code(404).send({ error: "document_not_found" });
        return;
      }
    }

    const session = await runtime.createSession(input);
    reply.code(201).send(session);
  });

  app.get("/agent/sessions/:id", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const session = await runtime.getSession(params.id);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    reply.send(session);
  });

  app.get("/agent/sessions/:id/messages", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const session = await runtime.getSession(params.id);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    const messages = await runtime.listSessionMessages(params.id);
    reply.send({ session, messages });
  });

  app.post("/agent/sessions/:id/messages", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const input = createAgentMessageSchema.parse(request.body);
    const trace = {
      traceId: String(request.id),
      startedAt: new Date().toISOString(),
    };
    logAgentRunStart(trace, input);
    const result = await knowledgeBaseAgent.sendMessage(params.id, input, { traceId: trace.traceId });
    reply.code(201).send(result);
  });

  app.post("/agent/sessions/:id/messages/stream", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const input = createAgentMessageSchema.pick({ content: true }).parse(request.body);
    const traceId = String(request.id);
    const stream = new SseWriter(reply, { sessionId: params.id, traceId });
    stream.open();
    try {
      await knowledgeBaseAgent.sendMessage(params.id, input, {
        traceId,
        onEvent: async (event) => stream.write(event),
      });
    } catch (error) {
      app.log.error({ err: error, traceId }, "knowledge_base_agent_stream_failed");
    } finally {
      stream.close();
    }
  });

  app.post("/agent/tasks", async (request, reply) => {
    const input = runAgentTaskSchema.parse(request.body);
    const trace = {
      traceId: String(request.id),
      startedAt: new Date().toISOString(),
    };
    logAgentRunStart(trace, input);

    app.log.warn({ path: "/agent/tasks", traceId: trace.traceId }, "agent_tasks_route_is_legacy");

    const doc = await opts.prisma.document.findUnique({
      where: { id: input.documentId },
      select: { id: true, status: true },
    });

    if (!doc) {
      reply.code(404).send({ error: "document_not_found" });
      return;
    }
    if (doc.status !== "ready") {
      reply.code(409).send({ error: "document_not_ready" });
      return;
    }

    const result = await runtime.run(input, trace);
    reply.send(result);
  });
};
