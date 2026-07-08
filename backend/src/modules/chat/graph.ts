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
import type { PrismaClient } from "@prisma/client";

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
  citations: Annotation<{ pageNumber: number; chunkId?: string; snippet: string; sourceType?: string }[]>({
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
  prisma?: PrismaClient,
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

    logger.info({ query: state.query.slice(0, 80), intent: resolved }, "[chat] classifyIntent 完成");
    return { intent: resolved };
  }

  async function retrieveContext(state: typeof ChatState.State) {
    if (state.intent === "chat") {
      return { retrievedContext: "", citations: [] };
    }

    // documentId 空值守卫
    if (!state.documentId) {
      logger.warn({ query: state.query.slice(0, 80) }, "[chat] retrieveContext: documentId 为空，跳过检索");
      return { retrievedContext: "", citations: [], finished: true };
    }

    // 检测文档类型（Word vs PDF），用于引用标签
    let sourceType = "pdf";
    if (prisma) {
      try {
        const doc = await prisma.document.findUnique({
          where: { id: state.documentId },
          select: { fileType: true },
        });
        sourceType = doc?.fileType === "docx" ? "docx" : "pdf";
      } catch (err: any) {
        logger.warn({ err: err.message }, "[chat] retrieveContext: 查询文档类型失败");
      }
    }

    const topK = state.intent === "complex_reasoning" ? 15 : 8;
    logger.info(
      { documentId: state.documentId, query: state.query.slice(0, 80), topK, sourceType },
      "[chat] retrieveContext 开始检索",
    );

    const results = await hybridSearch.search({
      documentIds: [state.documentId],
      query: state.query,
      topK,
    });

    logger.info(
      { resultCount: results.length, topK },
      "[chat] retrieveContext 检索完成",
    );

    // 过滤掉内容过短的 chunk（如表格中的单个数字），避免 LLM 收到无意义上下文。
    // CJK 字符信息密度远高于英文，5 个中文字符即可表达完整语义（如"本章小结"），
    // 因此使用 CJK 感知的判定而非固定 20 字符阈值。
    function isMeaningfulContent(text: string): boolean {
      if (!text || text.trim().length === 0) return false;
      const cjkCount = (text.match(/[一-鿿]/g) || []).length;
      // CJK 为主且至少有 5 个中文字符
      if (cjkCount >= 5) return true;
      // 混合/英文：至少 15 字符
      if (text.length >= 15) return true;
      return false;
    }
    const meaningfulResults = results.filter(
      (r) => isMeaningfulContent(r.fullContent || r.snippet),
    );
    if (meaningfulResults.length < results.length) {
      logger.info(
        { before: results.length, after: meaningfulResults.length },
        "[chat] retrieveContext 过滤短内容",
      );
    }
    // 打印前 2 条结果的前 120 字符，方便诊断内容质量
    meaningfulResults.slice(0, 2).forEach((r, i) => {
      logger.info(
        { idx: i, page: r.pageNumber, similarity: r.similarity?.toFixed(4), preview: (r.fullContent || r.snippet).slice(0, 120) },
        "[chat] retrieveContext 结果预览",
      );
    });

    // 空检索：回退到从 DocumentSection 加载全文作为上下文，
    // 避免 LLM 在无上下文的情况下生成"无法回答"的通用回复。
    if (meaningfulResults.length === 0) {
      logger.warn(
        { documentId: state.documentId, query: state.query.slice(0, 80) },
        "[chat] retrieveContext: 无有效检索结果，回退到全文上下文",
      );

      let fullContext = "";
      if (prisma) {
        try {
          const sections = await prisma.documentSection.findMany({
            where: { documentId: state.documentId },
            orderBy: { index: "asc" },
            select: { content: true },
          });
          const MAX_FALLBACK_CHARS = 8000;
          const parts: string[] = [];
          let totalChars = 0;
          for (const s of sections) {
            if (totalChars >= MAX_FALLBACK_CHARS) break;
            parts.push(s.content);
            totalChars += s.content.length;
          }
          fullContext = parts.join("\n\n");
          if (totalChars >= MAX_FALLBACK_CHARS) {
            fullContext = fullContext.slice(0, MAX_FALLBACK_CHARS) + "\n\n[文档过长，后续内容已截断]";
          }
          logger.info(
            { sectionsCount: sections.length, totalChars },
            "[chat] retrieveContext 全文回退加载完成",
          );
        } catch (err: any) {
          logger.error({ err: err.message }, "[chat] retrieveContext 全文回退失败");
        }
      }

      // 不设置 finished=true，让 generateAnswer 正常生成回答
      return {
        retrievedContext: fullContext
          ? `[全文上下文 — 因检索未能匹配到具体段落，提供完整文档内容供参考]\n\n${fullContext}`
          : "",
        citations: [],
        iterationCount: state.iterationCount + 1,
      };
    }

    const locationLabel = sourceType === "docx" ? "段落" : "页";
    const contextPieces = meaningfulResults.map(
      (r, i) => `[片段 ${i + 1}] (第 ${r.pageNumber} ${locationLabel}):\n${r.fullContent || r.snippet}`,
    );
    const citations = meaningfulResults.map((r) => ({
      pageNumber: r.pageNumber,
      chunkId: r.chunkId,
      snippet: r.snippet,
      sourceType,
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

    const ctxLen = (state.retrievedContext || "").length;
    logger.info(
      { intent: state.intent, contextLen: ctxLen, citationsCount: state.citations.length },
      "[chat] generateAnswer 开始生成",
    );
    if (ctxLen > 0) {
      logger.info(
        { contextPreview: state.retrievedContext.slice(0, 300) },
        "[chat] generateAnswer 上下文预览",
      );
    }

    const systemPrompt =
      state.intent === "chat"
        ? "你是一个友好的文档问答助手。用中文简洁回答用户的问题。"
        : `你是一个文档问答助手。**严格禁止**使用你自己的训练数据或外部知识，所有回答**必须且只能**基于提供的文档片段。

规则：
1. 如果文档中没有相关信息，直接回答"文档中未找到相关信息"，不要做任何猜测或补充。
2. 引用来源时，必须在对应的具体内容**紧后面**标注（如"......。[片段 1]"），**禁止**单独出现"[片段 X]"这类无上下文依托的标记。
3. 用中文简要、清晰地总结要点。`;

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

    // CRAG 自评：检查是否需要补充检索（基于真实检索结果，而非 LLM 答案）
    let needsMore = false;
    if (state.intent === "complex_reasoning" && state.iterationCount < 3) {
      logger.info(
        { iterationCount: state.iterationCount, citationsCount: state.citations.length },
        "[chat] generateAnswer CRAG 自评",
      );
      const decision = await cragService.evaluate(
        state.query,
        state.citations.map((c) => ({
          documentId: state.documentId,
          pageNumber: c.pageNumber,
          snippet: c.snippet,
          similarity: 0.5,
        })),
      );
      needsMore = decision.action !== "accept";
      logger.info(
        { action: decision.action, reason: decision.reason?.slice(0, 100) },
        "[chat] generateAnswer CRAG 结果",
      );
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
