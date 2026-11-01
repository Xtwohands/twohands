import { config } from "./config.js";
import type { Store } from "./store.js";
import type { Candidate, TraceEvent } from "./types.js";
export function analytics(store: Store) {
  const tasks = store.tasks().filter((t) => t.intent.consent);
  const minimum = config.minCohort;
  const base = { cohortSize: tasks.length, minCohort: minimum };
  if (tasks.length < minimum) return { suppressed: true as const, ...base };
  const histories = tasks.map((t) => ({ task: t, events: store.events(t.id) }));
  const events = histories.flatMap((h) => h.events);
  const protectedCount = (items: { taskId: string }[]) =>
    !items.length
      ? 0
      : new Set(items.map((e) => e.taskId)).size < minimum
        ? null
        : items.length;
  // First routing decision per normalized invocation: fallback rechecks are not new opportunities.
  const firstCandidates: TraceEvent[] = [];
  const firstSelections: TraceEvent[] = [];
  const seenCandidates = new Set<string>();
  const seenSelections = new Set<string>();
  for (const { task, events: history } of histories) {
    let invocation = "";
    for (const e of history) {
      if (e.type === "tool_invoked")
        invocation = e.data.invocationId || `${task.id}:${e.id}`;
      const key = e.data.invocationId || invocation;
      if (e.type === "provider_candidates" && !seenCandidates.has(key)) {
        seenCandidates.add(key);
        firstCandidates.push({ ...e, data: { ...e.data, invocationId: key } });
      }
      if (
        e.type === "route_selected" &&
        e.data.provider !== "firecrawl" &&
        !seenSelections.has(key)
      ) {
        seenSelections.add(key);
        firstSelections.push({ ...e, data: { ...e.data, invocationId: key } });
      }
    }
  }
  const winners = new Map(
    firstSelections.map((e) => [e.data.invocationId, e.data.provider]),
  );
  const providers = (["exa", "tavily", "firecrawl"] as const).map(
    (provider) => {
      const responses = events.filter(
        (e) => e.type === "provider_response" && e.data.provider === provider,
      );
      const candidateEvents = firstCandidates.filter((e) =>
        e.data.candidates.some((c: Candidate) => c.provider === provider),
      );
      if (
        new Set([...responses, ...candidateEvents].map((e) => e.taskId)).size <
        minimum
      )
        return { provider, suppressed: true as const };
      const performanceSuppressed =
        new Set(responses.map((e) => e.taskId)).size < minimum;
      const calls = new Set(responses.map((e) => e.callId));
      const checks = events.filter(
        (e) => e.type === "outcome_evaluated" && calls.has(e.callId),
      );
      const selected =
        provider === "firecrawl"
          ? events.filter(
              (e) =>
                e.type === "route_selected" && e.data.provider === provider,
            )
          : firstSelections.filter((e) => e.data.provider === provider);
      const eligible = candidateEvents.filter((e) =>
        e.data.candidates.some(
          (c: Candidate) => c.provider === provider && c.eligible,
        ),
      );
      const lossGroups = new Map<string, TraceEvent[]>();
      for (const event of candidateEvents) {
        const c = event.data.candidates.find(
          (c: Candidate) => c.provider === provider,
        ) as Candidate;
        const winner = winners.get(event.data.invocationId);
        const reasons = c.eligible
          ? winner && winner !== provider
            ? ["Lower weighted score on initial route"]
            : []
          : c.reasons;
        for (const reason of reasons)
          lossGroups.set(reason, [...(lossGroups.get(reason) || []), event]);
      }
      return {
        provider,
        suppressed: false as const,
        performanceSuppressed,
        eligible: provider === "firecrawl" ? null : protectedCount(eligible),
        selected: protectedCount(selected),
        calls: performanceSuppressed ? null : responses.length,
        httpSuccesses: performanceSuppressed
          ? null
          : responses.filter(
              (e) => e.data.httpStatus >= 200 && e.data.httpStatus < 300,
            ).length,
        successes: performanceSuppressed
          ? null
          : responses.filter((e) => e.data.success).length,
        latencyMs: performanceSuppressed
          ? null
          : Math.round(
              responses.reduce((a, e) => a + e.data.latencyMs, 0) /
                responses.length,
            ),
        estimatedMicros: performanceSuppressed
          ? null
          : events
              .filter(
                (e) =>
                  e.type === "budget_settled" && e.data.provider === provider,
              )
              .reduce((a, e) => a + e.data.estimateMicros, 0),
        coveragePasses: performanceSuppressed
          ? null
          : checks.filter((e) => e.data.pass).length,
        coverageChecks: performanceSuppressed ? null : checks.length,
        lossReasons: [...lossGroups].map(
          ([reason, items]) => [reason, protectedCount(items)] as const,
        ),
      };
    },
  );
  const failedCoverage = new Set(
    events
      .filter((e) => e.type === "outcome_evaluated" && e.data.pass === false)
      .map((e) => e.callId),
  );
  const passedCoverage = new Map(
    events
      .filter(
        (e) =>
          e.type === "outcome_evaluated" &&
          e.data.pass === true &&
          e.data.invocationId,
      )
      .map((e) => [e.data.invocationId, e.id]),
  );
  const insufficient200 = events.filter(
    (e) =>
      e.type === "provider_response" &&
      e.data.httpStatus === 200 &&
      failedCoverage.has(e.callId),
  );
  const fallbackEvents = events.filter((e) => e.type === "fallback_triggered");
  const recovered = fallbackEvents.filter(
    (e) =>
      e.data.invocationId &&
      (passedCoverage.get(e.data.invocationId) ?? 0) > e.id,
  );
  return {
    suppressed: false as const,
    ...base,
    providers,
    capabilities: {
      search: protectedCount(events.filter((e) => e.type === "tool_invoked")),
      extraction: protectedCount(
        events.filter(
          (e) =>
            e.type === "provider_request" &&
            e.data.capability === "research.fetch_url",
        ),
      ),
    },
    fallbacks: protectedCount(fallbackEvents),
    fallbackRecoveries: protectedCount(recovered),
    insufficient200: protectedCount(insufficient200),
    comparisons: protectedCount(
      events.filter((e) => e.type === "comparison_requested"),
    ),
    preferenceCounts: Object.fromEntries(
      ["balanced", "cost", "latency"].map((p) => [
        p,
        protectedCount(
          tasks
            .filter((t) => t.intent.preference === p)
            .map((t) => ({ taskId: t.id })),
        ),
      ]),
    ),
    note: "Initial-route opportunities are counted once per tool invocation; fallback checks do not inflate conversion. Coverage is not company verification. Costs are estimates. Small task, provider, and metric subcohorts are withheld; a dash means withheld or not applicable.",
  };
}
export type Analytics = ReturnType<typeof analytics>;
