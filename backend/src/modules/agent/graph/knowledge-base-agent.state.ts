import { Annotation } from "@langchain/langgraph";
import type { AgentIntent } from "../intent/intent-router.js";
import type { KnowledgeBaseSearchOutput } from "../tools/knowledge-base-search.tool.js";
import type { SearchResult } from "../../search/retrieval/post-processor.js";

export type AgentGraphDecision = "answer" | "narrow" | "refuse" | "clarify" | "chat" | "unsupported";
export type AgentHistoryMessage = { role: "user" | "assistant"; content: string };

export const KnowledgeBaseAgentState = Annotation.Root({
  message: Annotation<string>,
  history: Annotation<AgentHistoryMessage[]>({ reducer: (_, value) => value, default: () => [] }),
  intent: Annotation<AgentIntent | undefined>,
  resolvedQuery: Annotation<string | undefined>,
  round: Annotation<0 | 1 | 2>({ reducer: (_, value) => value, default: () => 0 }),
  search: Annotation<KnowledgeBaseSearchOutput | undefined>,
  answer: Annotation<string | undefined>,
  citations: Annotation<SearchResult[]>({ reducer: (_, value) => value, default: () => [] }),
  decision: Annotation<AgentGraphDecision | undefined>,
  emit: Annotation<((event: { type: string; data: Record<string, unknown> }) => void | Promise<void>) | undefined>,
});

export type KnowledgeBaseAgentStateType = typeof KnowledgeBaseAgentState.State;
