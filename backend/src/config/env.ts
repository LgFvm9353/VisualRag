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
  OCR_PROVIDER: z.enum(["http", "aliyun"]).optional(),
  OCR_ENDPOINT: z.string().url().optional(),
  OCR_API_KEY: z.string().optional(),
  ALIYUN_OCR_ACCESS_KEY_ID: z.string().min(1).optional(),
  ALIYUN_OCR_ACCESS_KEY_SECRET: z.string().min(1).optional(),
  ALIYUN_OCR_ENDPOINT: z.string().min(1).default("ocr-api.cn-hangzhou.aliyuncs.com"),
  ALIYUN_OCR_REGION_ID: z.string().min(1).default("cn-hangzhou"),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  OCR_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
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

  get ocr() {
    const env = getEnv();
    const provider = env.OCR_PROVIDER ?? (env.OCR_ENDPOINT ? "http" : undefined);
    if (!provider) return undefined;
    if (provider === "http") {
      if (!env.OCR_ENDPOINT) throw new Error("OCR_PROVIDER=http 时必须配置 OCR_ENDPOINT");
      return {
        provider,
        endpoint: env.OCR_ENDPOINT,
        apiKey: env.OCR_API_KEY,
        timeoutMs: env.OCR_TIMEOUT_MS,
        maxRetries: env.OCR_MAX_RETRIES,
      } as const;
    }
    if (!env.ALIYUN_OCR_ACCESS_KEY_ID || !env.ALIYUN_OCR_ACCESS_KEY_SECRET) {
      throw new Error("OCR_PROVIDER=aliyun 时必须配置 ALIYUN_OCR_ACCESS_KEY_ID 和 ALIYUN_OCR_ACCESS_KEY_SECRET");
    }
    return {
      provider,
      accessKeyId: env.ALIYUN_OCR_ACCESS_KEY_ID,
      accessKeySecret: env.ALIYUN_OCR_ACCESS_KEY_SECRET,
      endpoint: env.ALIYUN_OCR_ENDPOINT,
      regionId: env.ALIYUN_OCR_REGION_ID,
      timeoutMs: env.OCR_TIMEOUT_MS,
      maxRetries: env.OCR_MAX_RETRIES,
    } as const;
  },

  get chunking() {
    return {
      chunkSize: 512,
      chunkOverlap: 64,
      parentSize: 1536,
    } as const;
  },
};
