import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeBaseAgentGraph, AgentEventHandler } from "./graph/knowledge-base-agent.graph.js";
import type { AgentHistoryMessage } from "./graph/knowledge-base-agent.state.js";

export class KnowledgeBaseAgentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly graph: Pick<KnowledgeBaseAgentGraph, "invoke">,
  ) {}

  async createSession(input: { documentId?: string; title?: string | null }) {
    const session = await this.prisma.chatSession.create({
      data: {
        documentId: input.documentId ?? null,
        title: input.title ?? null,
      },
    });

    return this.toSessionDto(session);
  }

  async getSession(sessionId: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    return session ? this.toSessionDto(session) : null;
  }

  async listSessionMessages(sessionId: string) {
    const messages = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((message) => ({
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      status: message.status,
      traceId: message.traceId,
      intent: message.intent,
      resolvedQuery: message.resolvedQuery,
      citations: message.citations,
      metadata: message.metadataJson,
      errorCode: message.errorCode,
      startedAt: message.startedAt?.toISOString() ?? null,
      completedAt: message.completedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
    }));
  }

  async sendMessage(
    sessionId: string,
    input: { content: string },
    options: { traceId: string; onEvent?: AgentEventHandler },
  ) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!session) throw Object.assign(new Error("session_not_found"), { statusCode: 404 });

    const active = session.messages.some((message) => message.role === "assistant" && message.status === "processing");
    if (active) throw Object.assign(new Error("session_busy"), { statusCode: 409, code: "SESSION_BUSY" });

    const userMessage = await this.prisma.chatMessage.create({
      data: { sessionId, role: "user", content: input.content, status: "completed", completedAt: new Date() },
    });
    const assistantMessage = await this.prisma.chatMessage.create({
      data: { sessionId, role: "assistant", content: "", status: "processing", traceId: options.traceId, startedAt: new Date() },
    });
    await options.onEvent?.({ type: "message.accepted", data: { sessionId, messageId: assistantMessage.id } });

    const history: AgentHistoryMessage[] = session.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-20)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));

    try {
      const result = await this.graph.invoke({ message: input.content, history }, { onEvent: options.onEvent });
      const documentIds = [...new Set(result.citations.map((citation) => citation.documentId))];
      const documents = await this.prisma.document.findMany({
        where: { id: { in: documentIds } },
        select: { id: true, fileName: true, fileType: true },
      });
      const documentMap = new Map(documents.map((document) => [document.id, document]));
      const citations = result.citations.map((citation) => {
        const document = documentMap.get(citation.documentId);
        return {
          ...citation,
          fileName: document?.fileName ?? "未知文档",
          sourceType: document?.fileType ?? "pdf",
        };
      });
      const updated = await this.prisma.chatMessage.update({
        where: { id: assistantMessage.id },
        data: {
          content: result.answer ?? "",
          status: "completed",
          intent: result.intent,
          resolvedQuery: result.resolvedQuery,
          completedAt: new Date(),
          citations: JSON.parse(JSON.stringify({ items: citations, decision: result.decision })) as Prisma.InputJsonValue,
          metadataJson: JSON.parse(JSON.stringify({ round: result.round, decision: result.decision, search: result.search })) as Prisma.InputJsonValue,
        },
      });
      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { title: session.title ?? input.content.slice(0, 60) },
      });
      if (citations.length > 0) {
        await this.prisma.chatReference.createMany({
          data: citations.filter((citation) => citation.chunkId).map((citation) => ({
            messageId: assistantMessage.id,
            documentId: citation.documentId,
            chunkId: citation.chunkId!,
            score: citation.rerankScore ?? citation.rrfScore ?? citation.similarity ?? null,
          })),
        }).catch(() => undefined);
      }
      await options.onEvent?.({ type: "citations.completed", data: { citations } });
      await options.onEvent?.({ type: "message.completed", data: { message: updated } });
      return { sessionId, userMessage, assistantMessage: updated, result };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
      await this.prisma.chatMessage.update({
        where: { id: assistantMessage.id },
        data: { status: "failed", errorCode: code, completedAt: new Date() },
      });
      await options.onEvent?.({ type: "message.failed", data: { code, retryable: false, message: "Agent 执行失败" } });
      throw error;
    }
  }

  private toSessionDto(session: {
    id: string;
    documentId: string | null;
    title: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: session.id,
      documentId: session.documentId,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }
}
