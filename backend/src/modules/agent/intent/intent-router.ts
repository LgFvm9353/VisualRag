import type { ChatMessage, ChatModelGateway } from "../model/chat-model.gateway.js";

export type AgentIntent =
  | "greeting"
  | "knowledge_question"
  | "follow_up_question"
  | "session_control"
  | "ambiguous"
  | "unsupported";

export type IntentResult = {
  intent: AgentIntent;
  confidence: number;
  reason: string;
};

type ConversationMessage = Pick<ChatMessage, "role" | "content">;

const GREETING_PATTERN = /^(你好|您好|嗨|早上好|下午好|晚上好|谢谢|多谢|明白了|好的|再见)[！!。.\s]*$/;
const CAPABILITY_PATTERN = /^(你是谁|你能做什么|你可以做什么|支持什么)[？?。.\s]*$/;
const SESSION_CONTROL_PATTERN = /^(忽略前文|忽略前面的内容|重新开始|换个话题|清除上下文)[！!。.\s]*$/;

export class IntentRouter {
  constructor(private readonly gateway: ChatModelGateway) {}

  async classify(input: {
    message: string;
    history: ConversationMessage[];
  }): Promise<IntentResult> {
    const message = input.message.trim();
    if (GREETING_PATTERN.test(message) || CAPABILITY_PATTERN.test(message)) {
      return { intent: "greeting", confidence: 1, reason: "确定性寒暄或能力说明" };
    }
    if (SESSION_CONTROL_PATTERN.test(message)) {
      return { intent: "session_control", confidence: 1, reason: "确定性会话控制" };
    }

    const result = await this.gateway.completeJson<IntentResult>([
      {
        role: "system",
        content: [
          "你是企业知识库 Agent 的意图分类器，只输出 JSON。",
          "intent 只能是 greeting、knowledge_question、follow_up_question、session_control、ambiguous、unsupported。",
          "需要依赖历史才能理解的问题归为 follow_up_question；知识库外开放闲聊或外部实时请求归为 unsupported。",
          "输出 { intent, confidence, reason }。",
        ].join("\n"),
      },
      {
        role: "user",
        content: `历史:\n${input.history.map((item) => `${item.role}: ${item.content}`).join("\n")}\n当前消息: ${message}`,
      },
    ]);

    if (result.confidence < 0.55) {
      return { ...result, intent: "ambiguous" };
    }
    return result;
  }
}
