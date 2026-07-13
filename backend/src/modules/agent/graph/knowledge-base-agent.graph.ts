import { END, START, StateGraph } from "@langchain/langgraph";
import type { IntentRouter } from "../intent/intent-router.js";
import type { ConversationQueryResolver } from "../conversation/conversation-query-resolver.js";
import type { KnowledgeBaseSearchTool } from "../tools/knowledge-base-search.tool.js";
import type { RetrievalRetryPlanner } from "../retrieval/retry-planner.js";
import type { GroundedAnswerGenerator } from "../answer/grounded-answer.generator.js";
import { KnowledgeBaseAgentState, type AgentHistoryMessage, type KnowledgeBaseAgentStateType } from "./knowledge-base-agent.state.js";

export type AgentEventHandler = (event: { type: string; data: Record<string, unknown> }) => void | Promise<void>;

type Dependencies = {
  intentRouter: Pick<IntentRouter, "classify">;
  queryResolver: Pick<ConversationQueryResolver, "resolve">;
  searchTool: Pick<KnowledgeBaseSearchTool, "execute">;
  retryPlanner: Pick<RetrievalRetryPlanner, "plan">;
  answerGenerator: Pick<GroundedAnswerGenerator, "generate">;
};

const REFUSAL = "未找到足够证据来回答这个问题，请补充更具体的范围或关键词。";

export class KnowledgeBaseAgentGraph {
  private readonly graph;

  constructor(private readonly deps: Dependencies) {
    this.graph = new StateGraph(KnowledgeBaseAgentState)
      .addNode("classify", async (state) => {
        const result = await this.deps.intentRouter.classify({ message: state.message, history: state.history });
        await state.emit?.({ type: "intent.completed", data: result });
        return { intent: result.intent };
      })
      .addNode("resolve", async (state) => ({
        resolvedQuery: await this.deps.queryResolver.resolve({ message: state.message, history: state.history, intent: state.intent! }),
      }))
      .addNode("retrieve", async (state) => {
        const round = state.round === 0 ? 1 : state.round;
        const search = await this.deps.searchTool.execute({ query: state.resolvedQuery!, round });
        await state.emit?.({ type: "retrieval.completed", data: { round, hitCount: search.results.length, query: search.query } });
        await state.emit?.({ type: "evidence.completed", data: { round, decision: search.assessment.decision } });
        return { search, round };
      })
      .addNode("rewrite", async (state) => ({
        resolvedQuery: await this.deps.retryPlanner.plan({
          query: state.resolvedQuery!,
          snippets: state.search?.results.map((item) => item.snippet) ?? [],
        }) ?? state.resolvedQuery,
        round: 2 as const,
      }))
      .addNode("generate", async (state) => {
        const result = await this.deps.answerGenerator.generate({
          query: state.resolvedQuery!,
          evidence: state.search!.results,
          onDelta: async (delta) => state.emit?.({ type: "answer.delta", data: { delta } }),
        });
        return { answer: result.answer, citations: result.citations, decision: state.search!.assessment.decision };
      })
      .addNode("refuse", async () => ({ answer: REFUSAL, citations: [], decision: "refuse" as const }))
      .addNode("direct", async (state) => {
        if (state.intent === "greeting") return { answer: "你好，我可以基于当前企业知识库回答问题并提供原文引用。", decision: "chat" as const };
        if (state.intent === "ambiguous") return { answer: "请补充你想查询的具体主题或问题。", decision: "clarify" as const };
        if (state.intent === "session_control") return { answer: "好的，接下来的问题将作为新话题处理。", decision: "chat" as const };
        return { answer: "我主要负责企业知识库问答，请询问知识库中的制度、流程或文档内容。", decision: "unsupported" as const };
      })
      .addEdge(START, "classify")
      .addConditionalEdges("classify", (state) =>
        state.intent === "knowledge_question" || state.intent === "follow_up_question" ? "resolve" : "direct",
      )
      .addEdge("direct", END)
      .addEdge("resolve", "retrieve")
      .addConditionalEdges("retrieve", (state) => {
        if (state.search?.assessment.decision !== "refuse") return "generate";
        return state.round === 1 ? "rewrite" : "refuse";
      })
      .addEdge("rewrite", "retrieve")
      .addEdge("generate", END)
      .addEdge("refuse", END)
      .compile();
  }

  async invoke(input: { message: string; history: AgentHistoryMessage[] }, options?: { onEvent?: AgentEventHandler }) {
    const result = await this.graph.invoke(
      { ...input, round: 0, emit: options?.onEvent ?? (async () => undefined) },
      { recursionLimit: 12 },
    );
    return result as KnowledgeBaseAgentStateType;
  }
}
