import type OpenAI from "openai";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface ChatModelGateway {
  completeJson<T>(messages: ChatMessage[]): Promise<T>;
  streamText(messages: ChatMessage[]): AsyncIterable<string>;
}

type ChatClient = Pick<OpenAI, "chat">;

function modelError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export class OpenAICompatibleChatGateway implements ChatModelGateway {
  constructor(
    private readonly client: ChatClient,
    private readonly model: string,
  ) {}

  async completeJson<T>(messages: ChatMessage[]): Promise<T> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
    });
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw modelError("MODEL_EMPTY_RESPONSE", "模型返回了空响应");
    }
    try {
      return JSON.parse(content) as T;
    } catch {
      throw modelError("MODEL_INVALID_JSON", "模型返回的 JSON 无法解析");
    }
  }

  async *streamText(messages: ChatMessage[]): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      stream: true,
      messages,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
