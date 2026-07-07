import type { FastifyInstance } from "fastify";
import { config } from "../../config/env.js";

export async function registerCors(app: FastifyInstance) {
  const allowed = config.allowedOrigins;

  // 手动 CORS — @fastify/cors v9 在部分环境存在 header 丢失 bug
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;

    if (allowed.includes("*") || allowed.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
    }

    // 预检请求
    if (request.method === "OPTIONS") {
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id, x-api-key");
      reply.header("Access-Control-Max-Age", "86400");
      reply.code(204).send();
    }
  });
}
