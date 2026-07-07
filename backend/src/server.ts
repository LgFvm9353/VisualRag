/**
 * VisualRAG Insight 后端入口。
 *
 * 架构: Fastify 插件模式
 *   server/
 *     app.ts          Fastify 应用工厂 + Socket.IO
 *     plugins/        cors / auth / rate-limit
 *   modules/
 *     upload/         文件上传（分片 + 断点续传）
 *     document/       文档查询
 *     search/         检索（语义 + 关键字）
 *     chat/           对话（SSE 流式）
 *     ingestion/      文档处理管道
 *   db/
 *     prisma.ts       Prisma 客户端
 *   lib/
 *     logger.ts       Pino 日志
 *     errors.ts       统一错误类
 *   config/
 *     env.ts          Zod 环境变量校验
 */
import { startServer } from "./server/app.js";

void startServer();
