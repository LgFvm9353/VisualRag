import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";
import { loadEnv, config } from "../config/env.js";
import { registerAuth } from "./plugins/auth.js";
import { uploadRoutes } from "../modules/upload/upload.routes.js";
import { documentRoutes } from "../modules/document/document.routes.js";
import { agentRoutes } from "../modules/agent/agent.routes.js";
import { ProgressEmitter } from "../pipeline/progressEmitter.js";
import { IngestionPipeline } from "../pipeline/ingestionPipeline.js";
import { cleanupStaleUploads } from "../modules/upload/upload.service.js";

loadEnv();

export async function buildApp() {
  const app = Fastify({
    logger: logger,
    bodyLimit: 50 * 1024 * 1024, // 50MB
  });

  // ---- Plugins ----
  await app.register(registerAuth);

  // ---- CORS（内联，避免插件注册时序问题）----
  const allowedOrigins = config.allowedOrigins;
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;

    if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id, x-api-key");
      reply.header("Access-Control-Max-Age", "86400");
      return reply.code(204).send();
    }
  });

  // Content-type parser for binary chunk uploads
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  // ---- Socket.IO ----
  const io = new SocketIOServer(app.server, {
    cors: {
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }
        const allowed = config.allowedOrigins;
        if (allowed.includes("*") || allowed.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin not allowed"), false);
      },
    },
  });

  const progressEmitter = new ProgressEmitter(io);
  const pipeline = new IngestionPipeline(progressEmitter);

  io.on("connection", (socket) => {
    socket.on("join-task", (taskId: string) => {
      progressEmitter.joinRoom(taskId, socket.id);
    });
  });

  // ---- Routes ----
  app.register(uploadRoutes, { pipeline, prisma });
  app.register(documentRoutes, { pipeline, prisma });
  app.register(agentRoutes, { prisma });

  // ---- Health ----
  app.get("/health", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      reply.send({ status: "ok", db: "connected" });
    } catch (err: any) {
      app.log.error({ err }, "health_check_failed");
      reply.code(500).send({ status: "error", db: "disconnected" });
    }
  });

  // ---- Error handler ----
  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, "unhandled_error");
    const statusCode = (error as any).statusCode || 500;
    reply.code(statusCode).send({
      error: error.message || "内部服务器错误",
      code: (error as any).code || "INTERNAL_ERROR",
    });
  });

  return { app, io, pipeline };
}

export async function startServer() {
  const { app } = await buildApp();
  const port = config.allowedOrigins ? Number(process.env.PORT) || 4000 : 4000;

  try {
    void cleanupStaleUploads();
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`VisualRAG Insight backend running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
