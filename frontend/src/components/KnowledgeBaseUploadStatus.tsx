import type { IngestionStage } from "@/lib/knowledgeBaseApi";

export type UploadStatusState =
  | "hashing"
  | "uploading"
  | "processing"
  | "completed"
  | "failed";

export interface UploadStatus {
  fileName: string;
  state: UploadStatusState;
  progress: number;
  message: string;
  taskId?: string;
  error?: string;
  stage?: IngestionStage;
  deduplicated?: boolean;
}

interface KnowledgeBaseUploadStatusProps {
  status: UploadStatus | null;
}

const stageLabels: Record<IngestionStage, string> = {
  queued: "等待处理",
  extracting_text: "提取文本",
  layout_analysis: "分析版面",
  generating_text_embeddings: "生成文本向量",
  generating_image_embeddings: "生成图像向量",
  writing_database: "写入知识库",
  completed: "处理完成",
  failed: "处理失败",
};

export function KnowledgeBaseUploadStatus({
  status,
}: KnowledgeBaseUploadStatusProps) {
  if (!status) return null;

  const isFailed = status.state === "failed";
  const isCompleted = status.state === "completed";
  const message = status.error ?? status.message;

  return (
    <section
      aria-live="polite"
      className={`rounded-2xl border px-4 py-3 text-sm ${
        isFailed
          ? "border-red-100 bg-red-50 text-red-700"
          : isCompleted
            ? "border-emerald-100 bg-emerald-50 text-emerald-700"
            : "border-indigo-100 bg-indigo-50 text-indigo-700"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate font-medium">
          {isCompleted ? "文档上传并处理完成" : isFailed ? "文档处理失败" : message}
        </p>
        <span className="shrink-0 text-xs font-semibold">
          {isCompleted ? "100%" : `${Math.round(status.progress)}%`}
        </span>
      </div>
      {isFailed && status.error ? (
        <p className="mt-1 text-xs">{status.error}</p>
      ) : null}
      <p className="mt-1 truncate text-xs opacity-75">
        {status.fileName}
        {status.stage ? ` · ${stageLabels[status.stage]}` : ""}
        {status.deduplicated ? " · 已存在，已跳过重复处理" : ""}
      </p>
      {!isFailed && !isCompleted ? (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70"
          role="progressbar"
          aria-label="文档上传进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(status.progress)}
        >
          <div
            className="h-full rounded-full bg-indigo-600 transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, status.progress))}%` }}
          />
        </div>
      ) : null}
      {status.taskId ? (
        <p className="mt-1 text-[11px] opacity-60">任务：{status.taskId.slice(0, 8)}</p>
      ) : null}
    </section>
  );
}
