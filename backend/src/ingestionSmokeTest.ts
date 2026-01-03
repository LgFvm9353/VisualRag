import "dotenv/config";
import { join } from "path";
import { IngestionPipeline } from "./pipeline/ingestionPipeline.js";
import type { IngestionStage } from "./pipeline/types.js";

class NoopProgressEmitter {
  emit(taskId: string, payload: { stage: IngestionStage; progress: number; message?: string }) {}
  updateStage(taskId: string, stage: IngestionStage, progress: number, message?: string) {}
}

async function main() {
  const args = process.argv.slice(2);
  const sourcePath =
    args[0] ||
    join(process.cwd(), "uploads", "1767344337762-测试.pdf");
  const pipeline = new IngestionPipeline(new NoopProgressEmitter() as any);
  const task = pipeline.createTask({
    userId: "test-user",
    fileName: "test.pdf",
    fileType: "pdf",
    sourcePath,
  });
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  for (;;) {
    const current = pipeline.getTask(task.id);
    if (!current) {
      console.error("task_not_found");
      process.exit(1);
    }
    if (current.stage === "completed") {
      console.log("ingestion_completed");
      process.exit(0);
    }
    if (current.stage === "failed") {
      console.error("ingestion_failed", current.error);
      process.exit(1);
    }
    if (Date.now() - start > timeoutMs) {
      console.error("ingestion_timeout", current.stage);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main().catch((err) => {
  console.error("ingestion_unexpected_error", err);
  process.exit(1);
});

