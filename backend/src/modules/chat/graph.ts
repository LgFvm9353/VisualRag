/**
 * LangGraph 对话状态图 — 替换原有 LCEL 简单链。
 *
 * 节点:
 *   classifyIntent  → 意图识别（简单 / 复杂 / 闲聊）
 *   retrieveContext → 调用 Phase 2 混合检索
 *   generateAnswer  → 流式生成回答
 *   fillGaps        → CRAG 检索自评 + 补充检索
 *
 * 条件边:
 *   classifyIntent → 简单 → retrieveContext
 *                   → 闲聊 → generateAnswer
 *                   → 复杂 → retrieveContext（多轮）
 *   retrieveContext → generateAnswer
 *   generateAnswer  → fillGaps（如果信息不足）→ retrieveContext（循环最多 2 次）
 *                   → END（否则）
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { HybridSearchService } from "../search/retrieval/hybrid-search.service.js";
import type { CragService } from "../search/retrieval/crag.service.js";

// ---- State ----
const ChatState = Annotation.Root({
  query: Annotation<string>,
  documentId: Annotation<string>,
  conversationHistory: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: ((_prev: any, next: any) => next) as any,
  }),
  intent: Annotation<"simple_qa" | "complex_reasoning" | "chat">(),
  retrievedContext: Annotation<string>({
    default: () => "",
    reducer: ((_prev: any, next: any) => next) as any,
  }),
  citations: Annotation<{ pageNumber: number; chunkId?: string; snippet: string }[]>({
    default: () => [],
    reducer: ((_prev: any, next: any) => next) as any,
  }),
  answerTokens: Annotation<string[]>({
    default: () => [],
    reducer: ((_prev: any, next: any) => next) as any,
  }),
  iterationCount: Annotation<number>({
    default: () => 0,
    reducer: ((_prev: any, next: any) => next) as any,
  }),
  needsMoreContext: Annotation<boolean>({
    default: () => false,
    reducer: ((_prev: any, next: any) => next) as any,
  }),
  finished: Annotation<boolean>({
    default: () => false,
    reducer: ((_prev: any, next: any) => next) as any,
  }),
});

// ---- LLM ----
const intentLlm = new ChatOpenAI({
  model: config.chat.model,
  temperature: 0,
  configuration: { baseURL: config.chat.baseURL, apiKey: config.chat.apiKey },
});

const chatLlm = new ChatOpenAI({
  model: config.chat.model,
  streaming: true,
  temperature: 0.3,
  configuration: { baseURL: config.chat.baseURL, apiKey: config.chat.apiKey },
});

// ---- Intent Classification Prompt ----
const INTENT_PROMPT = `分析用户问题，判断意图类型。只输出以下之一: simple_qa, complex_reasoning, chat

规则:
- simple_qa: 可以直接从文档片段中找到答案的简单事实性问题（如"X 是多少？""Y 在哪一页？"）
- complex_reasoning: 需要综合多个文档片段、比较分析、或推理才能回答的问题
- chat: 闲聊、问候、元问题（如"你好""你能做什么？"），不需要检索文档

用户问题: {query}

意图类型:`;

// ---- Build Graph ----
export function buildChatGraph(
  hybridSearch: HybridSearchService,
  cragService: CragService,
) {
  async function classifyIntent(state: typeof ChatState.State) {
    const response = await intentLlm.invoke([
      new HumanMessage(INTENT_PROMPT.replace("{query}", state.query)),
    ]);
    const intent = (response.content as string).trim().toLowerCase();
    const validIntents = ["simple_qa", "complex_reasoning", "chat"];
    const resolved = validIntents.includes(intent)
      ? (intent as typeof ChatState.State["intent"])
      : "simple_qa";

    logger.debug({ query: state.query, intent: resolved }, "意图识别完成");
    return { intent: resolved };
  }

  async function retrieveContext(state: typeof ChatState.State) {
    if (state.intent === "chat") {
      return { retrievedContext: "", citations: [] };
    }

    const results = await hybridSearch.search({
      documentIds: [state.documentId],
      query: state.query,
      topK: state.intent === "complex_reasoning" ? 15 : 8,
    });

    const contextPieces = results.map(
      (r, i) => `[片段 ${i + 1}] (第 ${r.pageNumber} 页):\n${r.fullContent || r.snippet}`,
    );
    const citations = results.map((r) => ({
      pageNumber: r.pageNumber,
      chunkId: r.chunkId,
      snippet: r.snippet,
    }));

    return {
      retrievedContext: contextPieces.join("\n\n---\n\n"),
      citations,
      iterationCount: state.iterationCount + 1,
    };
  }

  async function generateAnswer(
    state: typeof ChatState.State,
    cfg?: RunnableConfig,
  ) {
    // 从 config 中获取流式 writer 回调
    const writer = (cfg?.configurable as any)?.writer as
      | ((token: string) => void)
      | undefined;

    const systemPrompt =
      state.intent === "chat"
        ? "你是一个友好的文档问答助手。用中文简洁回答用户的问题。"
        : `你是一个文档问答助手，只能基于提供的文档片段回答问题。
如果文档中没有相关信息，请明确说明无法从文档中回答。
回答时用中文简要、清晰地总结要点。每次陈述都要标注来源（如"[片段 X]"）。`;

    const contextBlock = state.retrievedContext
      ? `\n\n文档片段：\n${state.retrievedContext}`
      : "";

    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
    ];

    if (state.conversationHistory.length > 0) {
      messages.push(...state.conversationHistory);
    }

    messages.push(
      new HumanMessage(`问题：${state.query}${contextBlock}`),
    );

    const tokens: string[] = [];
    const stream = await chatLlm.stream(messages);

    for await (const chunk of stream) {
      const content = typeof chunk.content === "string"
        ? chunk.content
        : Array.isArray(chunk.content) && chunk.content.length > 0
          ? (chunk.content[0] as any)?.text ?? ""
          : "";
      if (content) {
        tokens.push(content);
        // 通过 writer 回调实时推送 token
        writer?.(content);
      }
    }

    // CRAG 自评：检查是否需要补充检索
    let needsMore = false;
    if (state.intent === "complex_reasoning" && state.iterationCount < 3) {
      const finalAnswer = tokens.join("");
      const decision = await cragService.evaluate(
        state.query,
        [{ documentId: state.documentId, pageNumber: 1, snippet: finalAnswer, similarity: 1 }],
      );
      needsMore = decision.action !== "accept";
    }

    return {
      answerTokens: tokens,
      needsMoreContext: needsMore,
      finished: !needsMore,
    };
  }

  const graph = new StateGraph(ChatState)
    .addNode("classifyIntent", classifyIntent)
    .addNode("retrieveContext", retrieveContext)
    .addNode("generateAnswer", generateAnswer)
    .addEdge(START, "classifyIntent")
    .addConditionalEdges("classifyIntent", (state: typeof ChatState.State) => {
      if (state.intent === "chat") return "generateAnswer";
      return "retrieveContext";
    })
    .addEdge("retrieveContext", "generateAnswer")
    .addConditionalEdges("generateAnswer", (state: typeof ChatState.State) => {
      if (state.needsMoreContext && state.iterationCount < 3) return "retrieveContext";
      return END;
    });

  return graph.compile();
}
