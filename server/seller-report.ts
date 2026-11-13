import type { Observatory } from "./observation.js";
import type { ProviderId } from "./types.js";
import type { ObservedCall, ObservationEvent } from "./observation-types.js";
import { providerRegistry } from "./provider-adapters.js";
import {
  taskTypes,
  taskTypeLabels,
  reasonThemeLabels,
  type TaskType,
  type ReasonTheme,
} from "./seller-taxonomy.js";

/** Shares are withheld below this many tasks. Counts are always shown. */
export const SELLER_MIN_SAMPLE = 30;

type Count = { key: string; label: string; count: number };
type Operation = "search" | "extract";
type Offer = {
  operations?: { operation: Operation; content?: string }[];
  tools?: {
    tool: string;
    provider: string;
    discoveryMatches?: {
      operationIndex: number;
      status: string;
    }[];
  }[];
};

const missedLabels: Record<string, string> = {
  "incompatible:complete_page":
    "Needed the complete page, which this tool cannot guarantee",
  "incompatible:page_text": "Needed page text, which this tool does not return",
  incompatible: "Request did not fit this tool",
  over_budget: "Estimate was over the task's remaining budget",
  disabled: "Turned off by the user or their key",
  unavailable: "Tool was not available",
  needs_parameters: "Request was incomplete",
};

const names: Record<string, string> = {
  exa: "Exa",
  tavily: "Tavily",
  firecrawl: "Firecrawl",
};

/**
 * What a tool company sees about agent choices. Aggregates only: never objectives,
 * queries, URLs, stated reasons, answers, model names or session IDs.
 *
 * A task is one recorded session. "Chosen" means the agent named the tool itself;
 * calls octolab routed are counted separately and never as a choice.
 */
export async function sellerReport(
  obs: Observatory,
  provider: ProviderId,
  options: {
    days: number;
    named: boolean;
    minSample?: number;
    now?: Date;
  },
) {
  const minSample = options.minSample ?? SELLER_MIN_SAMPLE;
  const now = options.now ?? new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - options.days + 1);
  start.setUTCHours(0, 0, 0, 0);
  const adapters = providerRegistry.list();
  const operationOf = Object.fromEntries(
    adapters.map((a) => [a.tool, a.operation]),
  ) as Record<string, Operation>;
  const operation = adapters.find((a) => a.provider === provider)!.operation;
  const rate = (n: number, d: number) => (d >= minSample ? n / d : null);
  // Without the opt-in, other companies are grouped and unnamed.
  const other = (p: string, op: Operation) =>
    options.named
      ? { key: p, label: names[p] ?? p }
      : {
          key: `other_${op}`,
          label: op === "search" ? "Other search tools" : "Other page tools",
        };
  const bump = (
    map: Map<string, Count>,
    key: string,
    label: string,
    by = 1,
  ) => {
    const row = map.get(key) ?? { key, label, count: 0 };
    row.count += by;
    map.set(key, row);
  };
  const sorted = (map: Map<string, Count>) =>
    [...map.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    );
  const theme = (c: ObservedCall) =>
    (c.reasonTheme ?? "unclassified") as ReasonTheme | "unclassified";

  const funnel = { eligible: 0, chosen: 0, succeeded: 0, cited: 0 };
  const byTask = new Map<
    TaskType,
    { eligible: number; you: number; none: number; rivals: Map<string, Count> }
  >();
  const reasonsFor = new Map<string, Count>();
  const reasonsAgainst = new Map<string, Count>();
  const lostTo = new Map<string, Count>();
  const missed = new Map<string, Count>();
  const failures = new Map<string, Count>();
  const afterFailure = new Map<string, Count>();
  const coUsage = new Map<string, Count>();
  const hosts = new Map<string, Count>();
  let calls = 0,
    succeededCalls = 0,
    emptyResults = 0,
    routedCalls = 0,
    estimateMicros = 0,
    usdCalls = 0,
    reportedUsd = 0,
    estimateMicrosForUsdCalls = 0;
  const latencies: number[] = [];

  const sessions = (await obs.db.list()).filter(
    (s) => s.commercialConsent && s.createdAt >= start.toISOString(),
  );
  for (const session of sessions) {
    const events = await obs.db.events(session.id);
    const sessionCalls = await obs.db.calls(session.id);
    const byId = new Map(sessionCalls.map((c) => [c.id, c]));
    const statuses = (e: ObservationEvent) => {
      const offer = e.data as Offer;
      const mine = offer.tools?.find((t) => t.provider === provider);
      return (mine?.discoveryMatches ?? [])
        .filter(
          (m) =>
            !offer.operations ||
            offer.operations[m.operationIndex]?.operation === operation,
        )
        .map((m) => ({
          status: m.status,
          content: offer.operations?.[m.operationIndex]?.content,
        }));
    };
    const offers = events.filter((e) => e.type === "tools_offered");
    const called = events.filter((e) => e.type === "tool_called");
    routedCalls += called.filter(
      (e) =>
        e.data.selectedBy === "server_route" &&
        byId.get(String(e.data.callId))?.provider === provider,
    ).length;
    // Agent choices only, in the order they happened.
    const chosenCalls = called
      .filter((e) => e.data.selectedBy !== "server_route")
      .map((e) => ({ at: e.id, call: byId.get(String(e.data.callId))! }))
      .filter((c) => c.call);
    const eligibleOffer = offers.find((e) =>
      statuses(e).some((m) => m.status === "eligible"),
    );
    if (!eligibleOffer) {
      const first = offers.flatMap(statuses)[0];
      if (first) {
        const key =
          first.status === "incompatible" &&
          ["complete_page", "page_text"].includes(first.content ?? "")
            ? `incompatible:${first.content}`
            : first.status;
        bump(missed, key, missedLabels[key] ?? key);
      }
      continue;
    }
    const after = chosenCalls.filter((c) => c.at > eligibleOffer.id);
    const mine = after.filter((c) => c.call.provider === provider);
    const rivals = after.filter(
      (c) =>
        c.call.provider !== provider && operationOf[c.call.tool] === operation,
    );
    const taskType = session.taskType ?? "other";
    const task = byTask.get(taskType) ?? {
      eligible: 0,
      you: 0,
      none: 0,
      rivals: new Map<string, Count>(),
    };
    byTask.set(taskType, task);
    funnel.eligible++;
    task.eligible++;
    if (!mine.length) {
      if (rivals.length) {
        const rival = other(rivals[0].call.provider, operation);
        bump(task.rivals, rival.key, rival.label);
        bump(lostTo, rival.key, rival.label);
        const t = theme(rivals[0].call);
        bump(reasonsAgainst, t, reasonThemeLabels[t]);
      } else task.none++;
      continue;
    }
    funnel.chosen++;
    task.you++;
    const first = theme(mine[0].call);
    bump(reasonsFor, first, reasonThemeLabels[first]);
    bump(hosts, session.host, session.host);
    for (const p of new Set(
      after
        .filter((c) => c.call.provider !== provider)
        .map((c) => `${c.call.provider}|${operationOf[c.call.tool]}`),
    )) {
      const [p2, op] = p.split("|") as [string, Operation];
      const row = other(p2, op);
      bump(coUsage, row.key, row.label);
    }
    const cited = new Set(session.outcomes.flatMap((o) => o.evidenceCallIds));
    if (mine.some((c) => c.call.status === "succeeded")) funnel.succeeded++;
    if (mine.some((c) => cited.has(c.call.id))) funnel.cited++;
    for (const { at, call } of mine) {
      if (!["succeeded", "failed"].includes(call.status)) continue;
      calls++;
      estimateMicros += call.estimateMicros;
      if (typeof call.latencyMs === "number") latencies.push(call.latencyMs);
      const usage = call.result?.usage as
        { providerReportedUsd?: unknown } | undefined;
      if (
        typeof usage?.providerReportedUsd === "number" &&
        Number.isFinite(usage.providerReportedUsd)
      ) {
        usdCalls++;
        reportedUsd += usage.providerReportedUsd;
        estimateMicrosForUsdCalls += call.estimateMicros;
      }
      if (call.status === "succeeded") {
        succeededCalls++;
        if (
          operation === "search" &&
          Array.isArray(call.result?.sources) &&
          !(call.result.sources as unknown[]).length
        )
          emptyResults++;
        continue;
      }
      const kind =
        call.httpStatus === 429
          ? ["rate_limited", "Rate limited"]
          : /time/i.test(call.error ?? "")
            ? ["timeout", "Timed out"]
            : call.httpStatus
              ? ["http", "Provider returned an error"]
              : ["other", "Request failed"];
      bump(failures, kind[0], kind[1]);
      const next = after.find((c) => c.at > at)?.call;
      if (!next) bump(afterFailure, "stopped", "Stopped searching");
      else if (next.provider === provider)
        bump(afterFailure, "retried", "Tried this tool again");
      else {
        const row = other(next.provider, operationOf[next.tool]);
        bump(afterFailure, `switched_${row.key}`, `Switched to ${row.label}`);
      }
    }
  }
  latencies.sort((a, b) => a - b);
  const simulation = await obs.db.store.db
    .prepare("SELECT body FROM workspace_settings WHERE key='simulation'")
    .get();
  return {
    provider,
    providerName: names[provider] ?? provider,
    operation,
    days: options.days,
    named: options.named,
    minSample,
    simulated: simulation
      ? (JSON.parse(simulation.body as string) as { note: string })
      : null,
    funnel: {
      ...funnel,
      chosenShare: rate(funnel.chosen, funnel.eligible),
      succeededShare: rate(funnel.succeeded, funnel.chosen),
      citedShare: rate(funnel.cited, funnel.succeeded),
    },
    lostTo: sorted(lostTo),
    byTaskType: taskTypes
      .filter((t) => byTask.has(t))
      .map((t) => {
        const row = byTask.get(t)!;
        return {
          taskType: t,
          label: taskTypeLabels[t],
          eligible: row.eligible,
          you: row.you,
          rivals: sorted(row.rivals),
          none: row.none,
          share: rate(row.you, row.eligible),
        };
      })
      .sort((a, b) => b.eligible - a.eligible),
    reasonsFor: sorted(reasonsFor),
    reasonsAgainst: sorted(reasonsAgainst),
    missed: sorted(missed),
    calls: {
      total: calls,
      succeeded: succeededCalls,
      failed: calls - succeededCalls,
      emptyResults,
      medianLatencyMs: latencies.length
        ? latencies[Math.floor((latencies.length - 1) / 2)]
        : null,
      failures: sorted(failures),
      afterFailure: sorted(afterFailure),
      routedByOctolab: routedCalls,
    },
    cost: {
      averageEstimateMicros: calls ? Math.round(estimateMicros / calls) : null,
      usdCalls,
      averageReportedUsd: usdCalls ? reportedUsd / usdCalls : null,
      averageEstimateUsdForReportedCalls: usdCalls
        ? estimateMicrosForUsdCalls / usdCalls / 1e6
        : null,
      ruledOutOnBudget: missed.get("over_budget")?.count ?? 0,
      lostOnCost: reasonsAgainst.get("lower_cost")?.count ?? 0,
    },
    coUsage: sorted(coUsage).map((c) => ({
      ...c,
      share: rate(c.count, funnel.chosen),
    })),
    hosts: sorted(hosts).map((c) => ({
      ...c,
      share: rate(c.count, funnel.chosen),
    })),
    notes: [
      "Covers agents connected to octolab, not the whole market.",
      "Chosen counts only the agent's own choice. Calls octolab routed are excluded.",
      "Reasons and task types are what agents reported, not private reasoning.",
      `A share is shown only with at least ${minSample} tasks behind it.`,
      "Cited means the final answer referenced the call, not that the answer was right.",
    ],
  };
}
export type SellerReport = Awaited<ReturnType<typeof sellerReport>>;
