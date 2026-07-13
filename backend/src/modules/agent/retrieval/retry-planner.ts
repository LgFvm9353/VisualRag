import type { ChatModelGateway } from "../model/chat-model.gateway.js";

export class RetrievalRetryPlanner {
  constructor(private readonly gateway: ChatModelGateway) {}

  async plan(input: { query: string; snippets: string[] }): Promise<string | null> {
    try {
      const result = await this.gateway.completeJson<{ query: string }>([
        {
          role: "system",
          content: "第一轮检索证据不足。根据原查询和命中的文档术语生成一次更适合检索的查询。只输出 JSON：{ query }，不要回答问题。",
        },
        {
          role: "user",
          content: `原查询: ${input.query}\n第一轮片段:\n${input.snippets.join("\n")}`,
        },
      ]);
      const query = result.query?.trim();
      return query && query !== input.query ? query : null;
    } catch {
      return null;
    }
  }
}
