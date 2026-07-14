import { z } from "zod";

export const createAgentSessionSchema = z.object({
  documentId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const createAgentMessageSchema = z.object({
  content: z.string().trim().min(1),
});
