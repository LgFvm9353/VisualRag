import type { FastifyInstance } from "fastify";
import { RateLimitError } from "../../lib/errors.js";

interface RateLimitStore {
  [key: string]: { count: number; resetAt: number };
}

/**
 * 轻量内存速率限制器，不依赖外部包。
 * 单进程内存实现，生产环境多实例部署时需替换为共享存储方案。
 */
export function createRateLimiter(opts: {
  max: number;
  windowMs: number;
}) {
  const store: RateLimitStore = {};

  // 定期清理过期条目
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(store)) {
      if (store[key].resetAt <= now) {
        delete store[key];
      }
    }
  }, opts.windowMs * 2);
  if (cleanupInterval.unref) cleanupInterval.unref();

  return async (key: string) => {
    const now = Date.now();
    const entry = store[key];

    if (!entry || entry.resetAt <= now) {
      store[key] = { count: 1, resetAt: now + opts.windowMs };
      return;
    }

    entry.count++;
    if (entry.count > opts.max) {
      throw new RateLimitError();
    }
  };
}

/** 聊天 SSE 路由专用：每用户每分钟 10 次 */
export const chatRateLimiter = createRateLimiter({ max: 10, windowMs: 60_000 });

/** 上传路由专用：每 IP 每分钟 5 次 */
export const uploadRateLimiter = createRateLimiter({ max: 5, windowMs: 60_000 });

/** 通用 API：每 IP 每分钟 100 次 */
export const globalRateLimiter = createRateLimiter({ max: 100, windowMs: 60_000 });
