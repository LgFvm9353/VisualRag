import type { SearchResult } from "./post-processor.js";

export type EvidenceDecision = "answer" | "refuse" | "narrow";

export interface EvidenceAssessment {
  decision: EvidenceDecision;
  reason: "sufficient_evidence" | "insufficient_evidence" | "limited_evidence";
  topScore: number;
  evidenceCount: number;
}

function getEvidenceScore(result: SearchResult): number {
  return result.rerankScore ?? result.rrfScore ?? result.similarity ?? 0;
}

export function assessEvidence(results: SearchResult[]): EvidenceAssessment {
  const sorted = [...results].sort((a, b) => getEvidenceScore(b) - getEvidenceScore(a));
  const topScore = sorted[0] ? getEvidenceScore(sorted[0]) : 0;
  const supporting = sorted.filter((result) => getEvidenceScore(result) >= 0.35);

  if (supporting.length === 0) {
    return {
      decision: "refuse",
      reason: "insufficient_evidence",
      topScore,
      evidenceCount: 0,
    };
  }

  if (supporting.length < 2) {
    return {
      decision: "narrow",
      reason: "limited_evidence",
      topScore,
      evidenceCount: supporting.length,
    };
  }

  return {
    decision: "answer",
    reason: "sufficient_evidence",
    topScore,
    evidenceCount: supporting.length,
  };
}
