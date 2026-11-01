import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { config } from "./config.js";
import { candidates, coverage } from "./router.js";
import { ProviderError, search, scrape } from "./providers.js";
import type { Store } from "./store.js";
import type { ProviderId, Source, Task } from "./types.js";
export class Engine {
  active = new Set<string>();
  cancelled = new Set<string>();
  cancel(taskId: string) {
    if (!this.active.has(taskId)) return false;
    this.cancelled.add(taskId);
    this.store.event(taskId, "cancellation_requested", {
      reason: "User requested stop; in-flight vendor calls must still settle",
    });
    return true;
  }
  timestamps = new Map<ProviderId, number[]>();
  constructor(public store: Store) {}
  available() {
    return Object.fromEntries(
      Object.entries(config.keys).map(([k, v]) => [k, Boolean(v)]),
    ) as Record<ProviderId, boolean>;
  }
  limited() {
    const now = Date.now();
    const set = new Set<ProviderId>();
    for (const [id, times] of this.timestamps) {
      const recent = times.filter((t) => now - t < 60000);
      this.timestamps.set(id, recent);
      if (recent.length >= config.rpm) set.add(id);
    }
    return set;
  }
  reserve(
    taskId: string,
    provider: ProviderId,
    callId: string,
    capability: string,
    args: object,
  ) {
    return this.store.transaction(() => {
      const task = this.store.get(taskId)!;
      if (
        this.store.events(taskId).filter((e) => e.type === "provider_request")
          .length >= 50
      )
        throw new Error("Task safety cap of 50 paid attempts reached");
      const estimate = config.prices[provider];
      if (
        task.spentMicros + task.reservedMicros + estimate >
        task.intent.budgetMicros
      )
        throw new Error("Remaining budget is insufficient");
      if (this.limited().has(provider))
        throw new Error("Provider rate limit reached");
      task.reservedMicros += estimate;
      this.store.save(task);
      this.store.event(
        taskId,
        "budget_reserved",
        {
          provider,
          estimateMicros: estimate,
          chargeType: "estimate",
          rateCardVersion: config.rateCardVersion,
        },
        callId,
      );
      this.store.event(
        taskId,
        "provider_request",
        { provider, capability, arguments: args, credentialsRedacted: true },
        callId,
      );
      this.timestamps.set(provider, [
        ...(this.timestamps.get(provider) || []),
        Date.now(),
      ]);
      return estimate;
    });
  }
  settle(
    taskId: string,
    callId: string,
    provider: ProviderId,
    estimate: number,
    response: object,
    sources?: Source[],
  ) {
    this.store.transaction(() => {
      if (
        this.store
          .events(taskId)
          .some((e) => e.type === "budget_settled" && e.callId === callId)
      )
        return;
      const task = this.store.get(taskId)!;
      if (sources) task.sources.push(...sources);
      task.reservedMicros -= estimate;
      task.spentMicros += estimate;
      this.store.save(task);
      this.store.event(
        taskId,
        "provider_response",
        { provider, ...response, quality: null },
        callId,
      );
      this.store.event(
        taskId,
        "budget_settled",
        {
          provider,
          estimateMicros: estimate,
          chargeType: "estimate",
          billingStatus: "unverified",
          rateCardVersion: config.rateCardVersion,
        },
        callId,
      );
    });
  }
  async execute(taskId: string, queryOrPlan: string | string[]) {
    let anySuccess = false;
    let anyCoverage = false;
    let completedQueries = 0;
    try {
      const queries = Array.isArray(queryOrPlan) ? queryOrPlan : [queryOrPlan];
      this.store.event(taskId, "plan_started", {
        queryCount: queries.length,
        planner: "explicit-user-plan-v1",
        maxPaidAttempts: queries.length * 2,
      });
      for (const [queryIndex, query] of queries.entries()) {
        if (this.cancelled.has(taskId)) break;
        const initial = this.store.get(taskId)!;
        if (
          this.store.events(taskId).filter((e) => e.type === "provider_request")
            .length >= 50
        ) {
          this.store.event(taskId, "route_blocked", {
            reason: "Task safety cap of 50 paid attempts reached",
          });
          break;
        }
        const invocationId = randomUUID();
        this.store.event(taskId, "tool_invoked", {
          invocationId,
          queryIndex,
          capability: "research.search",
          arguments: { query, domains: initial.intent.domains },
          mode: initial.intent.mode,
        });
        let querySuccesses = 0;
        let queryCoverage = false;
        const attempted = new Set<ProviderId>();
        for (let i = 0; i < 2; i++) {
          if (this.cancelled.has(taskId)) break;
          const task = this.store.get(taskId)!;
          const all = candidates(
            task.intent,
            task.intent.budgetMicros - task.spentMicros - task.reservedMicros,
            this.store.observations(),
            this.available(),
            this.limited(),
          );
          for (const c of all)
            if (attempted.has(c.provider)) {
              c.eligible = false;
              c.reasons.push("Already attempted for this invocation");
            }
          this.store.event(taskId, "provider_candidates", {
            invocationId,
            candidates: all,
            policyVersion: config.policyVersion,
          });
          const selected = all.find((c) => c.eligible);
          if (!selected) {
            this.store.event(taskId, "route_blocked", {
              reason:
                "No eligible provider; inspect credentials, budget, or rate limits.",
            });
            break;
          }
          attempted.add(selected.provider);
          const callId = randomUUID();
          this.store.event(
            taskId,
            "route_selected",
            {
              invocationId,
              provider: selected.provider,
              score: selected.score,
              components: selected.components,
              insufficientData: selected.insufficientData,
              reason:
                "Highest eligible weighted score; stable provider ID breaks ties",
              policyVersion: config.policyVersion,
            },
            callId,
          );
          const estimate = this.reserve(
            taskId,
            selected.provider,
            callId,
            "research.search",
            { query, domains: task.intent.domains },
          );
          const start = Date.now();
          let passed = false;
          try {
            const result = await search(
              selected.provider as "exa" | "tavily",
              query,
              task.intent.domains,
              callId,
            );
            const check = coverage(result.sources);
            passed = check.pass;
            anyCoverage ||= passed;
            anySuccess = true;
            querySuccesses++;
            queryCoverage ||= passed;
            this.settle(
              taskId,
              callId,
              selected.provider,
              estimate,
              {
                invocationId,
                success: true,
                httpStatus: result.httpStatus,
                latencyMs: Date.now() - start,
                resultCount: result.sources.length,
                returnedRefs: result.sources.map((s) => s.url),
                requestId: result.requestId,
                usage: result.usage,
              },
              result.sources,
            );
            this.store.event(
              taskId,
              "outcome_evaluated",
              { ...check, invocationId },
              callId,
            );
          } catch (e) {
            const err =
              e instanceof ProviderError ? e : new ProviderError("network");
            this.settle(taskId, callId, selected.provider, estimate, {
              invocationId,
              success: false,
              httpStatus: err.httpStatus ?? null,
              error: err.message,
              latencyMs: Date.now() - start,
              resultCount: 0,
            });
            this.store.event(
              taskId,
              "outcome_evaluated",
              {
                invocationId,
                pass: false,
                taskCriteria: "unknown",
                reason: "Provider execution failed",
              },
              callId,
            );
          }
          if (task.intent.mode === "route" && passed) break;
          if (i === 0)
            this.store.event(
              taskId,
              task.intent.mode === "compare"
                ? "comparison_requested"
                : "fallback_triggered",
              {
                reason:
                  task.intent.mode === "compare"
                    ? "User opted into two paid calls"
                    : "Provider error or insufficient evidence coverage",
                invocationId,
                budgetCheckedOnNextRoute: true,
              },
            );
        }
        if (
          queryCoverage &&
          (initial.intent.mode !== "compare" || querySuccesses === 2)
        )
          completedQueries++;
      }
      const final = this.store.get(taskId)!;
      final.status = this.cancelled.has(taskId)
        ? "partial"
        : anySuccess
          ? !anyCoverage || completedQueries < queries.length
            ? "partial"
            : "complete"
          : "failed";
      final.updatedAt = new Date().toISOString();
      this.store.save(final);
      this.store.event(taskId, "run_finished", {
        status: final.status,
        taskCriteria: "unknown",
        note: "Review sources against the intent rubric. API completion does not mean task completion.",
      });
    } catch {
      const task = this.store.get(taskId)!;
      task.status = "partial";
      task.error = "Run interrupted. Inspect the trace before retrying.";
      this.store.save(task);
      this.store.event(taskId, "run_error", { reason: task.error });
    } finally {
      this.active.delete(taskId);
      this.cancelled.delete(taskId);
    }
  }
  async fetchUrl(task: Task, sourceId: string) {
    const source = task.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error("Unknown source");
    const url = new URL(source.url);
    // Only public hostnames are allowed; Firecrawl performs remote retrieval. No local server fetch.
    if (
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      !url.hostname.includes(".") ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) ||
      url.port ||
      url.protocol !== "https:"
    )
      throw new Error("Extraction requires a public HTTPS hostname");
    const callId = randomUUID();
    this.store.event(
      task.id,
      "route_selected",
      {
        provider: "firecrawl",
        capability: "research.fetch_url",
        reason:
          "Configured extraction adapter; separate capability from search",
        policyVersion: config.policyVersion,
      },
      callId,
    );
    const estimate = this.reserve(
      task.id,
      "firecrawl",
      callId,
      "research.fetch_url",
      { url: source.url },
    );
    const start = Date.now();
    try {
      const result = await scrape(source.url);
      this.settle(task.id, callId, "firecrawl", estimate, {
        success: true,
        httpStatus: result.httpStatus,
        latencyMs: Date.now() - start,
        resultCount: 1,
        returnedRefs: [source.url],
      });
      const fresh = this.store.get(task.id)!;
      const s = fresh.sources.find((s) => s.id === sourceId)!;
      s.snippet = result.text;
      this.store.save(fresh);
      this.store.event(
        task.id,
        "extraction_received",
        { sourceId, characters: result.text.length, taskCriteria: "unknown" },
        callId,
      );
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("network");
      this.settle(task.id, callId, "firecrawl", estimate, {
        success: false,
        httpStatus: err.httpStatus ?? null,
        latencyMs: Date.now() - start,
        error: err.message,
        resultCount: 0,
      });
      throw err;
    }
  }
}
