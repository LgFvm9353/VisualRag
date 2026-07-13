import { logger } from "../../lib/logger.js";
import type { AgentResponse, CreateAgentMessageInput, RunAgentTaskInput } from "./types.js";

interface TraceContext {
  traceId: string;
  startedAt: string;
}

export function logAgentRunStart(trace: TraceContext, input: RunAgentTaskInput | CreateAgentMessageInput) {
  logger.info(
    {
      traceId: trace.traceId,
      startedAt: trace.startedAt,
      documentId: "documentId" in input ? input.documentId : undefined,
      taskType: input.taskType,
      promptPreview: ("prompt" in input ? input.prompt : input.content).slice(0, 200),
    },
    "agent_run_started",
  );
}

export function logAgentRunSuccess(trace: TraceContext, result: AgentResponse) {
  logger.info(
    {
      traceId: trace.traceId,
      startedAt: trace.startedAt,
      durationMs: result.trace.durationMs,
      taskType: result.taskType,
      retrieval: result.retrieval,
      citationCount: result.citations.length,
      evidenceCount: result.evidence.length,
      toolCalls: result.toolCalls.map((call) => call.name),
      title: result.title,
    },
    "agent_run_completed",
  );
}

export function logAgentRunFailure(trace: TraceContext, input: RunAgentTaskInput | CreateAgentMessageInput, error: unknown) {
  logger.error(
    {
      traceId: trace.traceId,
      startedAt: trace.startedAt,
      documentId: "documentId" in input ? input.documentId : undefined,
      taskType: input.taskType,
      err: error,
    },
    "agent_run_failed",
  );
}
