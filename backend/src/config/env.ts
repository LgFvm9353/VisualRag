import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_EMBEDDING_MODEL: z.string().default("embedding-2"),
  OPENAI_CHAT_MODEL: z.string().default("glm-4-flash"),
  FRONTEND_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  JWT_SECRET: z.string().min(16).default("change-me-in-production-use-a-strong-secret"),
  IMAGE_EMBEDDING_ENDPOINT: z.string().url().optional(),
  IMAGE_EMBEDDING_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`环境变量配置错误:\n${issues}`);
  }

  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) return loadEnv();
  return _env;
}

export const config = {
  get allowedOrigins(): string[] {
    const value = getEnv().FRONTEND_ORIGIN;
    if (value === "*") return ["*"];
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  },

  get embedding() {
    const env = getEnv();
    return { model: env.OPENAI_EMBEDDING_MODEL, baseURL: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY };
  },

  get chat() {
    const env = getEnv();
    return { model: env.OPENAI_CHAT_MODEL, baseURL: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY };
  },

  get chunking() {
    return {
      chunkSize: 512,
      chunkOverlap: 64,
      parentSize: 1536,
    } as const;
  },
};
