import type { ChatModelGateway } from "../model/chat-model.gateway.js";
import type { SearchResult } from "../../search/retrieval/post-processor.js";

function agentError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export class GroundedAnswerGenerator {
  constructor(private readonly gateway: ChatModelGateway) {}

  async generate(input: {
    query: string;
    evidence: SearchResult[];
    onDelta: (delta: string) => void | Promise<void>;
  }): Promise<{ answer: string; citations: SearchResult[] }> {
    if (input.evidence.length === 0) throw agentError("EVIDENCE_REQUIRED", "没有可用于回答的证据");
    const evidence = input.evidence.slice(0, 8);
    const messages = [
      {
        role: "system" as const,
        content: "你是企业知识库助手。只能依据证据回答；引用证据时使用 [E1] 格式，不得创建不存在的编号。",
      },
      {
        role: "user" as const,
        content: `问题: ${input.query}\n证据:\n${evidence.map((item, index) => `[E${index + 1}] ${item.fullContent || item.snippet}`).join("\n")}`,
      },
    ];
    let answer = "";
    for await (const delta of this.gateway.streamText(messages)) {
      answer += delta;
      await input.onDelta(delta);
    }
    const usedIndexes = [...answer.matchAll(/\[E(\d+)\]/g)]
      .map((match) => Number(match[1]) - 1)
      .filter((index) => index >= 0 && index < evidence.length);
    const citations = usedIndexes.length
      ? [...new Set(usedIndexes)].map((index) => evidence[index]!)
      : evidence;
    return { answer, citations };
  }
}
