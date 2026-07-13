import { z } from "zod";

export const agentTaskTypeSchema = z.enum(["qa", "summary", "extract", "compare"]);
export type AgentTaskType = z.infer<typeof agentTaskTypeSchema>;

export const documentSourceTypeSchema = z.enum(["pdf", "docx", "text", "html", "pptx"]);
export type DocumentSourceType = z.infer<typeof documentSourceTypeSchema>;

export const citationSchema = z.object({
  pageNumber: z.number().int().nonnegative(),
  sectionIndex: z.number().int().nonnegative().optional(),
  chunkId: z.string().optional(),
  snippet: z.string().default(""),
  sourceType: documentSourceTypeSchema.optional(),
});
export type AgentCitation = z.infer<typeof citationSchema>;

export const agentToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.any()).default({}),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

export const agentToolResultSchema = z.object({
  name: z.string(),
  summary: z.string(),
  payload: z.any(),
});
export type AgentToolResult = z.infer<typeof agentToolResultSchema>;

export const retrievalMetaSchema = z.object({
  hitCount: z.number().int().nonnegative(),
  cragAction: z.enum(["accept", "refine", "reject"]).default("accept"),
  refinedQuery: z.string().nullable().default(null),
  usedReranker: z.string().default("hybrid-heuristic-llm"),
});
export type RetrievalMeta = z.infer<typeof retrievalMetaSchema>;

export const agentTraceSchema = z.object({
  traceId: z.string(),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.string(),
});
export type AgentTrace = z.infer<typeof agentTraceSchema>;

export const agentResponseSchema = z.object({
  taskType: agentTaskTypeSchema,
  title: z.string(),
  answer: z.string(),
  evidence: z.array(z.string()).default([]),
  citations: z.array(citationSchema).default([]),
  toolCalls: z.array(agentToolCallSchema).default([]),
  retrieval: retrievalMetaSchema,
  trace: agentTraceSchema,
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export const assistantMessageBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    title: z.string().optional(),
  }),
  z.object({
    type: z.literal("evidence"),
    items: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("citations"),
    items: z.array(citationSchema).default([]),
  }),
  z.object({
    type: z.literal("retrieval"),
    retrieval: retrievalMetaSchema,
    trace: agentTraceSchema,
    toolCalls: z.array(agentToolCallSchema).default([]),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type AssistantMessageBlock = z.infer<typeof assistantMessageBlockSchema>;

export const storedAssistantMetaSchema = z.object({
  taskType: agentTaskTypeSchema.optional(),
  title: z.string().optional(),
  blocks: z.array(assistantMessageBlockSchema).default([]),
  citations: z.array(citationSchema).default([]),
  retrieval: retrievalMetaSchema.optional(),
  toolCalls: z.array(agentToolCallSchema).default([]),
  trace: agentTraceSchema.optional(),
});
export type StoredAssistantMeta = z.infer<typeof storedAssistantMetaSchema>;

export const createAgentSessionSchema = z.object({
  documentId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});
export type CreateAgentSessionInput = z.infer<typeof createAgentSessionSchema>;

export const createAgentMessageSchema = z.object({
  content: z.string().trim().min(1),
  taskType: agentTaskTypeSchema.optional(),
  documentId: z.string().uuid().optional(),
});
export type CreateAgentMessageInput = z.infer<typeof createAgentMessageSchema>;

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const agentConversationMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string(),
  blocks: z.array(assistantMessageBlockSchema).default([]),
  citations: z.array(citationSchema).default([]),
  retrieval: retrievalMetaSchema.optional(),
  toolCalls: z.array(agentToolCallSchema).default([]),
  trace: agentTraceSchema.optional(),
});
export type AgentConversationMessage = z.infer<typeof agentConversationMessageSchema>;

export const agentConversationResponseSchema = z.object({
  session: agentSessionSchema,
  userMessage: agentConversationMessageSchema,
  assistantMessage: agentConversationMessageSchema,
});
export type AgentConversationResponse = z.infer<typeof agentConversationResponseSchema>;

export const runAgentTaskSchema = z.object({
  documentId: z.string().uuid(),
  prompt: z.string().min(1),
  taskType: agentTaskTypeSchema,
});
export type RunAgentTaskInput = z.infer<typeof runAgentTaskSchema>;
