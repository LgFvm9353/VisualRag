import type { ChatModelGateway } from "../model/chat-model.gateway.js";
import type { AgentIntent } from "../intent/intent-router.js";

type HistoryMessage = { role: "user" | "assistant"; content: string };

export class ConversationQueryResolver {
  constructor(private readonly gateway: ChatModelGateway) {}

  async resolve(input: {
    message: string;
    history: HistoryMessage[];
    intent: AgentIntent;
  }): Promise<string> {
    if (input.intent !== "follow_up_question") return input.message;
    try {
      const result = await this.gateway.completeJson<{ query: string }>([
        {
          role: "system",
          content: "把依赖历史的用户追问补全为可独立检索的问题。只输出 JSON：{ query }。不要回答问题。",
        },
        {
          role: "user",
          content: `历史:\n${input.history.map((item) => `${item.role}: ${item.content}`).join("\n")}\n追问: ${input.message}`,
        },
      ]);
      return result.query?.trim() || input.message;
    } catch {
      return input.message;
    }
  }
}
