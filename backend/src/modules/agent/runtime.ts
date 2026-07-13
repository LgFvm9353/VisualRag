import OpenAI from "openai";
import { config } from "../../config/env.js";
import type { AgentContext } from "./tools/document-tools.js";
import { searchDocumentTool } from "./tools/search-document.tool.js";
import { HybridSearchService } from "../search/retrieval/hybrid-search.service.js";
import { LLMReranker } from "../search/retrieval/reranker.service.js";
import { extractQueryMetadata } from "../search/retrieval/query-metadata.js";
import { assessEvidence } from "../search/retrieval/evidence-gate.js";
import {
  askKnowledgeBaseResponseSchema,
  type AskKnowledgeBaseInput,
  type AskKnowledgeBaseResponse,
} from "../knowledge-base/knowledge-base.types.js";
import { getSectionsTool, getRegionsTool } from "./tools/document-tools.js";
import {
  type AgentConversationMessage,
  type AgentConversationResponse,
  type AgentResponse,
  type AgentTaskType,
  type AssistantMessageBlock,
  type CreateAgentMessageInput,
  type RunAgentTaskInput,
  agentConversationMessageSchema,
  agentConversationResponseSchema,
  agentResponseSchema,
  storedAssistantMetaSchema,
} from "./types.js";
import { logAgentRunFailure, logAgentRunSuccess } from "./trace.js";

const DEFAULT_TASK_TYPE: AgentTaskType = "qa";

const PROMPTS: Record<AgentTaskType, string> = {
  qa: "回答用户问题。只基于工具返回的文档证据作答；如果证据不足，明确说明。",
  summary: "基于文档内容生成结构化摘要，突出核心主题、关键结论与重要细节。",
  extract: "从文档中抽取关键事实、实体、时间、数字或要求项，尽量列表化。",
  compare: "对文档中与用户问题相关的内容做对比分析，突出相同点、差异点和依据。",
};

function buildEvidenceLines(payload: any): string[] {
  if (Array.isArray(payload)) {
    return payload.slice(0, 8).map((item: any, index) => {
      const pageNumber = item.pageNumber ?? item.index ?? item.sectionIndex ?? 0;
      const snippet = String(item.fullContent || item.content || item.snippet || "").slice(0, 300);
      return `[证据 ${index + 1}] page=${pageNumber}\n${snippet}`;
    });
  }
  return [JSON.stringify(payload).slice(0, 1000)];
}

function buildConversationHistory(messages: Array<{ role: string; content: string }>): string {
  return messages
    .slice(-8)
    .map((message) => `${message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User"}: ${message.content}`)
    .join("\n\n");
}

function buildAssistantBlocks(result: AgentResponse): AssistantMessageBlock[] {
  return [
    {
      type: "text",
      title: result.title,
      text: result.answer,
    },
    {
      type: "evidence",
      items: result.evidence,
    },
    {
      type: "citations",
      items: result.citations,
    },
    {
      type: "retrieval",
      retrieval: result.retrieval,
      trace: result.trace,
      toolCalls: result.toolCalls,
    },
  ];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class AgentRuntime {
  private openai: OpenAI;

  constructor(private ctx: AgentContext) {
    this.openai = new OpenAI({
      baseURL: config.chat.baseURL,
      apiKey: config.chat.apiKey,
    });
  }

  async askKnowledgeBase(
    input: AskKnowledgeBaseInput,
    options: { traceId: string; startedAt: string },
  ): Promise<AskKnowledgeBaseResponse> {
    const startedAtMs = Date.now();
    const filters = extractQueryMetadata(input.query);
    const search = new HybridSearchService(this.ctx.prisma, new LLMReranker());
    const results = await search.search({
      query: filters.residualQuery || input.query,
      topK: 8,
      publishedYear: filters.publishedYear,
      fileTypes: filters.fileTypes,
      tags: filters.tags,
    });
    const assessment = assessEvidence(results);
    const retrieval = {
      hitCount: results.length,
      cragAction: assessment.decision === "answer" ? "accept" as const : "reject" as const,
      refinedQuery: filters.residualQuery !== input.query ? filters.residualQuery : null,
      usedReranker: "hybrid-llm-reranker",
    };
    const trace = {
      traceId: options.traceId,
      durationMs: Date.now() - startedAtMs,
      startedAt: options.startedAt,
    };

    if (assessment.decision === "refuse") {
      return askKnowledgeBaseResponseSchema.parse({
        answer: "未找到足够证据来回答这个问题，请补充更具体的范围或关键词。",
        decision: "refuse",
        citations: [],
        retrieval,
        trace,
      });
    }

    const documentIds = [...new Set(results.map((item) => item.documentId))];
    const documents = await this.ctx.prisma.document.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, fileName: true, fileType: true },
    });
    const documentMap = new Map(documents.map((document) => [document.id, document]));
    const evidence = results.slice(0, 5);
    const response = await this.openai.chat.completions.create({
      model: config.chat.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是企业知识库问答助手。",
            "只能基于给定证据回答，不得补充外部知识。",
            "证据不完整时必须明确说明范围不足。",
            "输出 JSON：{ answer }。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            input.history.length
              ? `历史对话:\n${input.history.map((item) => `${item.role}: ${item.content}`).join("\n")}`
              : null,
            `用户问题: ${input.query}`,
            "证据:",
            ...evidence.map((item, index) => `[${index + 1}] ${item.fullContent || item.snippet}`),
          ].filter(Boolean).join("\n"),
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");

    return askKnowledgeBaseResponseSchema.parse({
      answer: parsed.answer || "证据有限，暂时无法形成可靠答案。",
      decision: assessment.decision,
      citations: evidence.map((item) => {
        const document = documentMap.get(item.documentId);
        return {
          documentId: item.documentId,
          fileName: document?.fileName ?? "未知文档",
          pageNumber: item.pageNumber,
          chunkId: item.chunkId,
          snippet: item.snippet,
          sourceType: document?.fileType ?? "pdf",
        };
      }),
      retrieval,
      trace: { ...trace, durationMs: Date.now() - startedAtMs },
    });
  }

  private async generateAgentResponse(
    input: { documentId: string; prompt: string; taskType?: AgentTaskType },
    options: { traceId: string; startedAt: string; conversationHistory?: string },
  ): Promise<AgentResponse> {
    const taskType = input.taskType ?? DEFAULT_TASK_TYPE;
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const evidenceBlocks: string[] = [];
    const citations: AgentResponse["citations"] = [];
    const startedAtMs = Date.now();

    try {
      const document = await this.ctx.prisma.document.findUnique({
        where: { id: input.documentId },
        select: { fileType: true },
      });
      const sourceType = (document?.fileType ?? "pdf") as AgentResponse["citations"][number]["sourceType"];

      const sections = await getSectionsTool(this.ctx, input.documentId);
      toolCalls.push({ name: "get_sections", args: { documentId: input.documentId } });

      const regions = await getRegionsTool(this.ctx, input.documentId);
      toolCalls.push({ name: "get_regions", args: { documentId: input.documentId } });

      const search = await searchDocumentTool(this.ctx.prisma, input.documentId, input.prompt, taskType === "compare" ? 12 : 8);
      toolCalls.push({ name: "search_document", args: { documentId: input.documentId, query: input.prompt } });

      evidenceBlocks.push(...buildEvidenceLines(search.payload));

      for (const result of search.payload.slice(0, 6)) {
        citations.push({
          pageNumber: result.pageNumber ?? 0,
          chunkId: result.chunkId,
          snippet: result.snippet ?? "",
          sourceType,
        });
      }

      const response = await this.openai.chat.completions.create({
        model: config.chat.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你是知识库 Agent。",
              PROMPTS[taskType],
              "你必须只依据提供的文档证据回答，不得补充外部知识。",
              "输出 JSON：{ title, answer, evidence }。evidence 为字符串数组，总结你实际采用的证据。",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              options.conversationHistory ? `历史对话:\n${options.conversationHistory}` : null,
              `用户请求: ${input.prompt}`,
              `文档段落数: ${sections.payload.length}`,
              `布局页数: ${Array.isArray(regions.payload) ? regions.payload.length : 0}`,
              `检索命中数: ${search.retrieval.hitCount}`,
              `CRAG 动作: ${search.retrieval.cragAction}`,
              search.retrieval.refinedQuery ? `Refined Query: ${search.retrieval.refinedQuery}` : null,
              "可用证据:",
              evidenceBlocks.join("\n\n"),
            ].filter(Boolean).join("\n"),
          },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw);

      const result = agentResponseSchema.parse({
        taskType,
        title: parsed.title || "分析结果",
        answer: parsed.answer || "未生成结果",
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : evidenceBlocks.slice(0, 4),
        citations,
        toolCalls,
        retrieval: search.retrieval,
        trace: {
          traceId: options.traceId,
          durationMs: Date.now() - startedAtMs,
          startedAt: options.startedAt,
        },
      });

      logAgentRunSuccess(options, result);
      return result;
    } catch (error) {
      logAgentRunFailure(options, { documentId: input.documentId, prompt: input.prompt, taskType }, error);
      throw error;
    }
  }

  async run(
    input: RunAgentTaskInput,
    options: { traceId: string; startedAt: string },
  ): Promise<AgentResponse> {
    return this.generateAgentResponse(input, options);
  }

  async createSession(input: { documentId?: string; title?: string | null }) {
    const session = await this.ctx.prisma.chatSession.create({
      data: {
        documentId: input.documentId ?? null,
        title: input.title ?? null,
      },
    });

    return {
      id: session.id,
      documentId: session.documentId,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  async getSession(sessionId: string) {
    const session = await this.ctx.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return null;
    return {
      id: session.id,
      documentId: session.documentId,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  async listSessionMessages(sessionId: string): Promise<AgentConversationMessage[]> {
    const messages = await this.ctx.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((message) => {
      const parsed = storedAssistantMetaSchema.safeParse(message.citations ?? {});
      return agentConversationMessageSchema.parse({
        id: message.id,
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
        createdAt: toIsoString(message.createdAt),
        blocks: parsed.success ? parsed.data.blocks : [],
        citations: parsed.success ? parsed.data.citations : [],
        retrieval: parsed.success ? parsed.data.retrieval : undefined,
        toolCalls: parsed.success ? parsed.data.toolCalls : [],
        trace: parsed.success ? parsed.data.trace : undefined,
      });
    });
  }

  async appendMessage(
    sessionId: string,
    input: CreateAgentMessageInput,
    options: { traceId: string; startedAt: string },
  ): Promise<AgentConversationResponse> {
    const session = await this.ctx.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) {
      throw Object.assign(new Error("session_not_found"), { statusCode: 404 });
    }

    const documentId = input.documentId ?? session.documentId;
    if (!documentId) {
      throw Object.assign(new Error("session_document_required"), { statusCode: 400 });
    }

    const doc = await this.ctx.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, status: true },
    });

    if (!doc) {
      throw Object.assign(new Error("document_not_found"), { statusCode: 404 });
    }
    if (doc.status !== "ready") {
      throw Object.assign(new Error("document_not_ready"), { statusCode: 409 });
    }

    const userMessageRecord = await this.ctx.prisma.chatMessage.create({
      data: {
        sessionId,
        role: "user",
        content: input.content,
      },
    });

    const conversationHistory = buildConversationHistory(
      [...session.messages, { role: "user", content: input.content }].map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );

    const result = await this.generateAgentResponse(
      {
        documentId,
        prompt: input.content,
        taskType: input.taskType ?? DEFAULT_TASK_TYPE,
      },
      {
        ...options,
        conversationHistory,
      },
    );

    const blocks = buildAssistantBlocks(result);
    const assistantMessageRecord = await this.ctx.prisma.chatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: result.answer,
        citations: {
          taskType: result.taskType,
          title: result.title,
          blocks,
          citations: result.citations,
          retrieval: result.retrieval,
          toolCalls: result.toolCalls,
          trace: result.trace,
        },
      },
    });

    if (result.citations.length > 0) {
      await this.ctx.prisma.chatReference.createMany({
        data: result.citations
          .filter((citation) => citation.chunkId)
          .map((citation) => ({
            messageId: assistantMessageRecord.id,
            documentId,
            chunkId: citation.chunkId!,
            score: null,
          })),
      }).catch(() => undefined);
    }

    const updatedSession = await this.ctx.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        documentId,
        title: session.title ?? input.content.slice(0, 60),
      },
    });

    return agentConversationResponseSchema.parse({
      session: {
        id: updatedSession.id,
        documentId: updatedSession.documentId,
        title: updatedSession.title,
        createdAt: updatedSession.createdAt.toISOString(),
        updatedAt: updatedSession.updatedAt.toISOString(),
      },
      userMessage: {
        id: userMessageRecord.id,
        sessionId: userMessageRecord.sessionId,
        role: userMessageRecord.role,
        content: userMessageRecord.content,
        createdAt: userMessageRecord.createdAt.toISOString(),
        blocks: [{ type: "text", text: userMessageRecord.content }],
        citations: [],
        toolCalls: [],
      },
      assistantMessage: {
        id: assistantMessageRecord.id,
        sessionId: assistantMessageRecord.sessionId,
        role: assistantMessageRecord.role,
        content: assistantMessageRecord.content,
        createdAt: assistantMessageRecord.createdAt.toISOString(),
        blocks,
        citations: result.citations,
        retrieval: result.retrieval,
        toolCalls: result.toolCalls,
        trace: result.trace,
      },
    });
  }
}
