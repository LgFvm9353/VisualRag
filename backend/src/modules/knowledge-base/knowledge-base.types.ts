import { z } from "zod";
import { documentSourceTypeSchema, retrievalMetaSchema } from "../agent/types.js";

export const knowledgeBaseHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export const askKnowledgeBaseSchema = z.object({
  query: z.string().trim().min(1),
  history: z.array(knowledgeBaseHistoryMessageSchema).max(20).default([]),
});
export type AskKnowledgeBaseInput = z.infer<typeof askKnowledgeBaseSchema>;

export const knowledgeBaseCitationSchema = z.object({
  documentId: z.string().uuid(),
  fileName: z.string(),
  pageNumber: z.number().int().nonnegative(),
  chunkId: z.string().optional(),
  snippet: z.string(),
  sourceType: documentSourceTypeSchema,
});
export type KnowledgeBaseCitation = z.infer<typeof knowledgeBaseCitationSchema>;

export const askKnowledgeBaseResponseSchema = z.object({
  answer: z.string(),
  decision: z.enum(["answer", "refuse", "narrow"]),
  citations: z.array(knowledgeBaseCitationSchema),
  retrieval: retrievalMetaSchema,
  trace: z.object({
    traceId: z.string(),
    durationMs: z.number().int().nonnegative(),
    startedAt: z.string(),
  }),
});
export type AskKnowledgeBaseResponse = z.infer<typeof askKnowledgeBaseResponseSchema>;
