/**
 * 统一业务错误类，继承自 Error。
 * 捕获后在 Fastify error handler 中映射为 HTTP 状态码。
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = "INTERNAL_ERROR",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const msg = id ? `${resource} not found: ${id}` : `${resource} not found`;
    super(msg, 404, "NOT_FOUND");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "未授权访问") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "无权访问此资源") {
    super(message, 403, "FORBIDDEN");
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "请求过于频繁，请稍后再试") {
    super(message, 429, "RATE_LIMITED");
  }
}

export class EmbeddingNotConfiguredError extends AppError {
  constructor() {
    super("向量模型未配置（缺少 OPENAI_API_KEY）", 500, "EMBEDDING_NOT_CONFIGURED");
  }
}
