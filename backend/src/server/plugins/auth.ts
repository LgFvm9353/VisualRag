import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * 轻量认证插件（本项不需要用户系统，仅做请求上下文占位）。
 */
export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest("user", null);

  app.addHook("preHandler", async (request) => {
    (request as any).user = {};
  });
}

declare module "fastify" {
  interface FastifyRequest {
    user: Record<string, unknown>;
  }
}
