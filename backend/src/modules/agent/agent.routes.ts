import type { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import OpenAI from "openai";
import { z } from "zod";
import { config } from "../../config/env.js";
import { HybridSearchService } from "../search/retrieval/hybrid-search.service.js";
import { LLMReranker } from "../search/retrieval/reranker.service.js";
import { GroundedAnswerGenerator } from "./answer/grounded-answer.generator.js";
import { ConversationQueryResolver } from "./conversation/conversation-query-resolver.js";
import { KnowledgeBaseAgentGraph } from "./graph/knowledge-base-agent.graph.js";
import { IntentRouter } from "./intent/intent-router.js";
import { KnowledgeBaseAgentService } from "./knowledge-base-agent.service.js";
import { OpenAICompatibleChatGateway } from "./model/chat-model.gateway.js";
import { RetrievalRetryPlanner } from "./retrieval/retry-planner.js";
import { SseWriter } from "./stream/sse-writer.js";
import { KnowledgeBaseSearchTool } from "./tools/knowledge-base-search.tool.js";
import {
  createAgentMessageSchema,
  createAgentSessionSchema,
} from "./types.js";

interface AgentRoutesOptions {
  prisma: PrismaClient;
}

const sessionParamsSchema = z.object({ id: z.string().uuid() });

function createKnowledgeBaseAgent(prisma: PrismaClient): KnowledgeBaseAgentService {
  const chatGateway = new OpenAICompatibleChatGateway(
    new OpenAI({
      baseURL: config.chat.baseURL,
      apiKey: config.chat.apiKey,
    }),
    config.chat.model,
  );
  const reranker = new LLMReranker();
  const searchService = new HybridSearchService(prisma, reranker);
  const graph = new KnowledgeBaseAgentGraph({
    intentRouter: new IntentRouter(chatGateway),
    queryResolver: new ConversationQueryResolver(chatGateway),
    searchTool: new KnowledgeBaseSearchTool(searchService),
    retryPlanner: new RetrievalRetryPlanner(chatGateway),
    answerGenerator: new GroundedAnswerGenerator(chatGateway),
  });

  return new KnowledgeBaseAgentService(prisma, graph);
}

export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, opts) => {
  const knowledgeBaseAgent = createKnowledgeBaseAgent(opts.prisma);

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
      const document = await opts.prisma.document.findUnique({
        where: { id: input.documentId },
        select: { id: true },
      });
      if (!document) {
        reply.code(404).send({ error: "document_not_found" });
        return;
      }
    }

    const session = await knowledgeBaseAgent.createSession(input);
    reply.code(201).send(session);
  });

  app.get("/agent/sessions/:id", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const session = await knowledgeBaseAgent.getSession(params.id);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    reply.send(session);
  });

  app.get("/agent/sessions/:id/messages", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const session = await knowledgeBaseAgent.getSession(params.id);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    const messages = await knowledgeBaseAgent.listSessionMessages(params.id);
    reply.send({ session, messages });
  });

  app.post("/agent/sessions/:id/messages", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const input = createAgentMessageSchema.parse(request.body);
    const result = await knowledgeBaseAgent.sendMessage(params.id, input, {
      traceId: String(request.id),
    });
    reply.code(201).send(result);
  });

  app.post("/agent/sessions/:id/messages/stream", async (request, reply) => {
    const params = sessionParamsSchema.parse(request.params);
    const input = createAgentMessageSchema.parse(request.body);
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
};
