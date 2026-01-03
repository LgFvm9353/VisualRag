import "dotenv/config";
import OpenAI from "openai";

async function main() {
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    console.error("chat_model_env_missing");
    process.exit(1);
  }
  const client = new OpenAI({
    baseURL,
    apiKey,
  });
  const model = process.env.OPENAI_CHAT_MODEL || "glm-4-flash";
  try {
    const result = await client.chat.completions.create({
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: "请用一句话自我介绍。",
        },
      ],
    });
    const content = result.choices[0]?.message?.content || "";
    console.log("chat_model_ok", content.slice(0, 50));
    process.exit(0);
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const code = err?.code ?? err?.response?.data?.code;
    const message =
      err?.error?.message ||
      err?.response?.data?.message ||
      err?.message ||
      String(err);
    console.error("chat_model_error", status, code, message);
    process.exit(1);
  }
}

void main();

