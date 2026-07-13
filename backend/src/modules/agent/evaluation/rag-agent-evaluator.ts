export type RagAgentEvalCase = {
  expectedIntent: string;
  actualIntent: string;
  expectedDecision: string;
  actualDecision: string;
  citationsValid: boolean;
  round1Evidence: number;
  finalEvidence: number;
};

export function evaluateRagAgent(cases: RagAgentEvalCase[]) {
  if (cases.length === 0) return { intentAccuracy: 0, decisionAccuracy: 0, citationAccuracy: 0, secondRoundGainRate: 0 };
  const retryCases = cases.filter((item) => item.round1Evidence === 0 && item.finalEvidence > 0);
  return {
    intentAccuracy: cases.filter((item) => item.expectedIntent === item.actualIntent).length / cases.length,
    decisionAccuracy: cases.filter((item) => item.expectedDecision === item.actualDecision).length / cases.length,
    citationAccuracy: cases.filter((item) => item.citationsValid).length / cases.length,
    secondRoundGainRate: retryCases.length === 0 ? 0 : retryCases.filter((item) => item.finalEvidence > item.round1Evidence).length / retryCases.length,
  };
}
