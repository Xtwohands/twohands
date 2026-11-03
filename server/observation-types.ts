export type ToolName = "exa_search" | "tavily_search" | "firecrawl_extract";
export type ReviewVerdict = "pass" | "fail" | "unknown";
export interface Criterion {
  id: string;
  text: string;
  weight: number;
}
export interface Outcome {
  id: string;
  at: string;
  text: string;
  evidenceCallIds: string[];
  source: "agent_reported";
}
export interface ReviewAuthor {
  kind: "unspecified" | "human_reported" | "assistant_reported";
  label?: string;
}
export interface Evaluation {
  reviewer?: ReviewAuthor;
  historical?: true;
  id: string;
  at: string;
  outcomeId: string;
  intentHash: string;
  source: "workspace_review";
  criteria: {
    criterionId: string;
    verdict: ReviewVerdict;
    note: string;
    evidenceCallIds: string[];
  }[];
  score: number | null;
  coverage: number;
  passedWeight: number;
  failedWeight: number;
  unknownWeight: number;
}
export interface ReviewCase {
  id: string;
  at: string;
  evaluationId: string;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  resolution?: string;
  updatedAt: string;
}
export interface ObservationSession {
  id: string;
  title: string;
  objective: string;
  criteria: Criterion[];
  constraints: string;
  intentHash: string;
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
  model: string;
  modelSource: "agent_reported" | "operator_entered";
  host: string;
  status: "awaiting_approval" | "active" | "completed";
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  authorizationSource?: "backend_policy" | "workspace_operator";
  commercialConsent: boolean;
  sharingPolicy?: string;
  outcomes: Outcome[];
  evaluations: Evaluation[];
  cases: ReviewCase[];
}
export interface ObservedCall {
  id: string;
  sessionId: string;
  requestKey: string;
  tool: ToolName;
  provider: "exa" | "tavily" | "firecrawl";
  arguments: {
    query?: string;
    url?: string;
    domains?: string[];
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
  };
  costEstimate?: import("./request-cost.js").RequestEstimate;
  statedReason: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  latencyMs?: number;
  estimateMicros: number;
  httpStatus?: number;
  error?: string;
  result?: Record<string, unknown>;
}
export interface ObservationEvent {
  id: number;
  sessionId: string;
  at: string;
  type: string;
  provenance: "observed" | "agent_reported" | "workspace_review";
  data: Record<string, unknown>;
  previousHash: string;
  hash: string;
}
export interface SessionDetail extends ObservationSession {
  calls: ObservedCall[];
  events: ObservationEvent[];
  integrity: boolean;
}

export type ObservationListItem = Omit<
  ObservationSession,
  "outcomes" | "evaluations"
> & {
  outcomes: Pick<Outcome, "id" | "at">[];
  evaluations: Pick<Evaluation, "id" | "outcomeId">[];
};
export function observationListItem(
  s: ObservationSession,
): ObservationListItem {
  return {
    ...s,
    outcomes: s.outcomes.map(({ id, at }) => ({ id, at })),
    evaluations: s.evaluations.map(({ id, outcomeId }) => ({ id, outcomeId })),
  };
}
