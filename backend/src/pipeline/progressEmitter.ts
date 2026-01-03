import type { Server as SocketIOServer } from "socket.io";
import type { IngestionProgressEvent, IngestionStage } from "./types.js";

export class ProgressEmitter {
  private io: SocketIOServer;

  constructor(io: SocketIOServer) {
    this.io = io;
  }

  emit(taskId: string, payload: Omit<IngestionProgressEvent, "taskId">) {
    const event: IngestionProgressEvent = { taskId, ...payload };
    this.io.to(this.roomName(taskId)).emit("ingestion:progress", event);
  }

  joinRoom(taskId: string, socketId: string) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.join(this.roomName(taskId));
    }
  }

  updateStage(taskId: string, stage: IngestionStage, progress: number, message?: string) {
    this.emit(taskId, { stage, progress, message });
  }

  private roomName(taskId: string) {
    return `ingestion:${taskId}`;
  }
}
