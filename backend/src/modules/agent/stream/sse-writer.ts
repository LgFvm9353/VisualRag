import type { FastifyReply } from "fastify";
import { randomUUID } from "crypto";

export class SseWriter {
  private sequence = 0;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly reply: FastifyReply,
    private readonly context: { sessionId: string; messageId?: string; traceId: string },
  ) {}

  open() {
    this.reply.hijack();
    this.reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.heartbeat = setInterval(() => this.reply.raw.write(": heartbeat\n\n"), 15_000);
  }

  write(event: { type: string; data: Record<string, unknown> }) {
    if (event.type === "message.accepted" && typeof event.data.messageId === "string") {
      this.context.messageId = event.data.messageId;
    }
    this.sequence += 1;
    const envelope = {
      eventId: randomUUID(),
      sessionId: this.context.sessionId,
      messageId: this.context.messageId ?? "pending",
      traceId: this.context.traceId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      data: event.data,
    };
    this.reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (!this.reply.raw.writableEnded) this.reply.raw.end();
  }
}
