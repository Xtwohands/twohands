import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ProviderId } from "./types.js";
import { config, providerEstimate } from "./config.js";
import { search, scrape, ProviderError } from "./providers.js";
import { digest } from "./observation-store.js";
import { ObservationError } from "./observation.js";
import { toolCapabilities } from "./provider-capabilities.js";
import {
  suiteCases,
  suiteVersion,
  suiteMethodology,
} from "./provider-lab-suite.js";
import type {
  LabRun,
  Experiment,
  ControlledSample,
} from "./provider-lab-types.js";

const provider = z.enum(["exa", "tavily", "firecrawl"]);
export const labRunInput = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    providers: z
      .array(provider)
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length, "Choose each provider once"),
  })
  .strict();
export const labReviewInput = z
  .object({
    verdict: z.enum(["useful", "partial", "not_useful", "unknown"]),
    note: z.string().trim().min(10).max(3000),
    author: z
      .enum(["human_reported", "assistant_reported", "unspecified"])
      .default("unspecified"),
  })
  .strict();
export const experimentInput = z
  .object({
    provider,
    verification: z
      .enum(["retrieval", "agent_choice", "integration"])
      .default("retrieval"),
    title: z.string().trim().min(3).max(160),
    hypothesis: z.string().trim().min(10).max(3000),
    change: z.string().trim().min(10).max(3000),
    successMeasure: z.string().trim().min(10).max(3000),
    status: z.enum(["planned", "testing", "reviewed"]).default("planned"),
    baselineRunId: z.string().uuid().nullable().default(null),
    followupRunId: z.string().uuid().nullable().default(null),
    conclusion: z.string().trim().max(3000).default(""),
  })
  .strict();

export { measure, labMeasurements } from "./provider-lab-metrics.js";
import { measure, labMeasurements } from "./provider-lab-metrics.js";

export class ProviderLab {
  active = new Set<string>();
  constructor(
    private store: Store,
    private adapters = { search, scrape },
    private timestamps = new Map<ProviderId, number[]>(),
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS provider_lab_runs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS provider_experiments(id TEXT PRIMARY KEY,body TEXT NOT NULL);",
    );
  }
  list(): LabRun[] {
    return this.store.db
      .prepare("SELECT body FROM provider_lab_runs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  summaries(): LabRun[] {
    // Keep large captured pages out of recurring dashboard reads.
    return this.store.db
      .prepare(
        `SELECT json_set(body,'$.calls',json((
      SELECT json_group_array(json_remove(value,'$.result'))
      FROM json_each(provider_lab_runs.body,'$.calls')
    ))) AS body FROM provider_lab_runs ORDER BY rowid DESC`,
      )
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  controlledSamples(): Partial<Record<ProviderId, ControlledSample>> {
    const runs = this.summaries();
    return Object.fromEntries(
      (["exa", "tavily", "firecrawl"] as ProviderId[]).flatMap((provider) => {
        const run = runs.find(
          (r) =>
            r.status === "completed" &&
            r.calls.some(
              (c) =>
                c.provider === provider &&
                ["succeeded", "failed"].includes(c.status),
            ),
        );
        if (!run) return [];
        const m = labMeasurements([run]).find((m) => m.provider === provider)!;
        return [
          [
            provider,
            {
              source: "backend_forced",
              runId: run.id,
              suiteVersion: run.suiteVersion,
              completedAt: run.finishedAt!,
              attempted: m.attempted,
              succeeded: m.succeeded,
              referencePassed: m.referencePassed,
              referenceKnown: m.referenceKnown,
              reviewed: m.reviewed,
              useful: m.useful,
              partial: m.partial,
              limitations:
                "Fixed public-reference diagnostic cases, forced by the backend. Reference checks are not factual accuracy. Usefulness verdicts are attributed reports, not independent verification. Small sample; no general quality ranking or organic preference is established.",
            },
          ],
        ];
      }),
    );
  }
  get(id: string): LabRun {
    const row = this.store.db
      .prepare("SELECT body FROM provider_lab_runs WHERE id=?")
      .get(id);
    if (!row) throw new ObservationError(404, "Test run not found.");
    return JSON.parse(row.body as string);
  }
  private save(run: LabRun) {
    run.revision = (run.revision ?? 0) + 1;
    this.store.db
      .prepare(
        "INSERT INTO provider_lab_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(run.id, run.requestKey, JSON.stringify(run));
  }
  recover() {
    for (const run of this.list().filter((r) => r.status === "running")) {
      for (const c of run.calls) {
        if (c.status === "running") {
          c.status = "interrupted";
          c.error =
            "Server stopped before a receipt was saved. The reserved estimate is consumed conservatively; no automatic retry.";
          c.finishedAt = new Date().toISOString();
          run.spentMicros += c.estimateMicros;
        } else if (c.status === "pending") c.status = "skipped";
      }
      run.reservedMicros = 0;
      run.status = "interrupted";
      run.finishedAt = new Date().toISOString();
      this.save(run);
    }
  }
  overview() {
    const runs = this.summaries();
    const dailyCommittedMicros = this.committedToday(runs);
    return {
      suiteVersion,
      methodology: suiteMethodology,
      cases: suiteCases,
      backendBudgetMicros: config.providerTestBudgetMicros,
      dailyBudgetMicros: config.providerTestDailyBudgetMicros,
      dailyCommittedMicros,
      dailyRemainingMicros: Math.max(
        0,
        config.providerTestDailyBudgetMicros - dailyCommittedMicros,
      ),
      providers: (["exa", "tavily", "firecrawl"] as ProviderId[]).map((id) => ({
        id,
        configured: !!config.keys[id],
        estimateMicros: providerEstimate(id),
        plannedCalls: 5,
      })),
      runs,
      measurements: labMeasurements(runs),
      experiments: this.experiments(),
    };
  }
  private committedToday(runs: LabRun[]) {
    const today = new Date().toISOString().slice(0, 10);
    return runs
      .filter((r) => r.createdAt.startsWith(today))
      .reduce(
        (n, r) =>
          n + (r.status === "running" ? r.plannedMicros : r.spentMicros),
        0,
      );
  }
  start(raw: unknown) {
    const input = labRunInput.parse(raw);
    const providers = [...input.providers].sort() as ProviderId[];
    const signature = digest({ providers, suiteVersion });
    const existing = this.store.db
      .prepare("SELECT body FROM provider_lab_runs WHERE request_key=?")
      .get(input.requestKey);
    if (existing) {
      const run = JSON.parse(existing.body as string) as LabRun;
      if (run.signature !== signature)
        throw new ObservationError(
          409,
          "This request key belongs to a different test plan.",
        );
      return run;
    }
    const priorRuns = this.summaries();
    if (this.active.size || priorRuns.some((r) => r.status === "running"))
      throw new ObservationError(
        409,
        "A controlled test is already running. Wait for it to finish or stop it.",
      );
    if (providers.some((p) => !config.keys[p]))
      throw new ObservationError(
        409,
        "Configure every selected provider on the backend before running a live test.",
      );
    const cases = suiteCases.filter((c) =>
      c.kind === "search"
        ? providers.some((p) => p !== "firecrawl")
        : providers.includes("firecrawl"),
    );
    const offset = priorRuns.length % 2;
    const calls = cases.flatMap((c, i) => {
      const order =
        c.kind === "extract"
          ? ["firecrawl" as const]
          : providers.filter((p) => p !== "firecrawl");
      if ((i + offset) % 2) order.reverse();
      return order.map((p) => ({
        id: randomUUID(),
        caseId: c.id,
        provider: p,
        status: "pending" as const,
        estimateMicros: providerEstimate(p),
        reviews: [],
      }));
    });
    const plannedMicros = calls.reduce((n, c) => n + c.estimateMicros, 0);
    if (plannedMicros > config.providerTestBudgetMicros)
      throw new ObservationError(
        409,
        "The test plan exceeds the backend test budget. Choose fewer providers or have the operator adjust backend policy.",
      );
    const daily = this.committedToday(priorRuns);
    if (daily + plannedMicros > config.providerTestDailyBudgetMicros)
      throw new ObservationError(
        409,
        "The backend daily test allowance is exhausted. No provider calls were started.",
      );
    const run: LabRun = {
      id: randomUUID(),
      requestKey: input.requestKey,
      signature,
      title: "Public reference checks",
      source: "live_controlled",
      suiteVersion,
      suiteHash: digest(cases),
      status: "running",
      cancelRequested: false,
      providers,
      createdAt: new Date().toISOString(),
      authorizationSource: "backend_policy",
      budgetMicros: config.providerTestBudgetMicros,
      plannedMicros,
      spentMicros: 0,
      reservedMicros: 0,
      rateCardVersion: config.rateCardVersion,
      adapterSnapshot: Object.fromEntries(
        Object.entries(toolCapabilities).map(([k, v]) => [k, v.adapter]),
      ),
      cases,
      calls,
    };
    this.save(run);
    this.active.add(run.id);
    void this.execute(run.id)
      .catch(() => {
        try {
          const failed = this.get(run.id);
          failed.status = "interrupted";
          failed.finishedAt = new Date().toISOString();
          for (const c of failed.calls) {
            if (c.status === "running") {
              c.status = "interrupted";
              c.finishedAt = new Date().toISOString();
              c.error =
                "Execution stopped before settlement could be saved. No automatic retry.";
              failed.spentMicros += c.estimateMicros;
            } else if (c.status === "pending") c.status = "skipped";
          }
          failed.reservedMicros = 0;
          this.save(failed);
        } catch {
          // Preserve the durable reservation for startup recovery if storage is unavailable.
          console.error(
            "Provider lab could not persist settlement; the saved reservation requires startup recovery.",
          );
        }
      })
      .finally(() => this.active.delete(run.id));
    return this.get(run.id);
  }
  private async execute(id: string) {
    for (const planned of this.get(id).calls) {
      let run = this.get(id);
      if (run.cancelRequested) break;
      const call = run.calls.find((c) => c.id === planned.id)!;
      const now = Date.now();
      this.timestamps.set(
        call.provider,
        (this.timestamps.get(call.provider) || []).filter(
          (t) => now - t < 60000,
        ),
      );
      if (this.timestamps.get(call.provider)!.length >= config.rpm) {
        call.status = "skipped";
        call.error = "Shared provider rate limit reached. Not retried.";
        this.save(run);
        continue;
      }
      if (
        run.spentMicros + run.reservedMicros + call.estimateMicros >
        run.budgetMicros
      )
        throw new Error("Test ledger would exceed its cap");
      call.status = "running";
      call.startedAt = new Date().toISOString();
      run.reservedMicros += call.estimateMicros;
      this.save(run);
      this.timestamps.get(call.provider)!.push(now);
      const test = run.cases.find((c) => c.id === call.caseId)!;
      let result: Record<string, unknown> | undefined;
      let error: string | undefined;
      let httpStatus: number | undefined;
      try {
        result = (call.provider === "firecrawl"
          ? await this.adapters.scrape(test.input)
          : await this.adapters.search(
              call.provider,
              test.input,
              [],
              call.id,
            )) as unknown as Record<string, unknown>;
        httpStatus = result.httpStatus as number;
      } catch (e) {
        error =
          e instanceof ProviderError ? e.message : "Provider request failed.";
        httpStatus = e instanceof ProviderError ? e.httpStatus : undefined;
      }
      run = this.get(id);
      const settled = run.calls.find((c) => c.id === call.id)!;
      Object.assign(settled, {
        status: error ? "failed" : "succeeded",
        finishedAt: new Date().toISOString(),
        latencyMs: Date.now() - now,
        error,
        httpStatus,
        ...(result ? { result, measurements: measure(test, result) } : {}),
      });
      run.reservedMicros -= call.estimateMicros;
      run.spentMicros += call.estimateMicros;
      this.save(run);
    }
    const run = this.get(id);
    for (const c of run.calls) if (c.status === "pending") c.status = "skipped";
    run.status = run.cancelRequested ? "cancelled" : "completed";
    run.finishedAt = new Date().toISOString();
    this.save(run);
  }
  cancel(id: string) {
    const run = this.get(id);
    if (run.status === "running") {
      run.cancelRequested = true;
      this.save(run);
    }
    return run;
  }
  review(id: string, callId: string, raw: unknown) {
    const input = labReviewInput.parse(raw);
    const run = this.get(id);
    const call = run.calls.find((c) => c.id === callId);
    if (!call) throw new ObservationError(404, "Test receipt not found.");
    if (["pending", "running", "skipped"].includes(call.status))
      throw new ObservationError(
        409,
        "This call has no settled receipt to review.",
      );
    call.reviews.push({ ...input, at: new Date().toISOString() });
    this.save(run);
    return run;
  }
  experiments(): Experiment[] {
    return this.store.db
      .prepare("SELECT body FROM provider_experiments ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  pruneOlderThan(cutoff: string) {
    return this.store.transaction(() => {
      const plans = this.store.db
        .prepare(
          "DELETE FROM provider_experiments WHERE json_extract(body,'$.status')='reviewed' AND json_extract(body,'$.updatedAt') < ?",
        )
        .run(cutoff);
      const linked = new Set(
        this.experiments()
          .flatMap((p) => [p.baselineRunId, p.followupRunId])
          .filter(Boolean),
      );
      let runs = 0;
      for (const run of this.summaries()) {
        const updated = [
          run.createdAt,
          run.finishedAt ?? run.createdAt,
          ...run.calls.flatMap((c) => c.reviews.map((r) => r.at)),
        ]
          .sort()
          .at(-1)!;
        if (
          run.status !== "running" &&
          !linked.has(run.id) &&
          updated < cutoff
        ) {
          this.store.db
            .prepare("DELETE FROM provider_lab_runs WHERE id=?")
            .run(run.id);
          runs++;
        }
      }
      return { runs, plans: Number(plans.changes) };
    });
  }
  saveExperiment(raw: unknown, id?: string) {
    const input = experimentInput.parse(raw);
    const old = id ? this.experiments().find((e) => e.id === id) : undefined;
    if (id && !old) throw new ObservationError(404, "Test plan not found.");
    if (
      input.verification === "agent_choice" &&
      (input.baselineRunId || input.followupRunId)
    )
      throw new ObservationError(
        400,
        "Forced-provider runs cannot verify agent choice. Record external-agent evidence in the plan instead.",
      );
    if (input.followupRunId && input.followupRunId === input.baselineRunId)
      throw new ObservationError(
        400,
        "Choose two different runs for a comparison.",
      );
    for (const rid of [input.baselineRunId, input.followupRunId])
      if (rid) {
        const run = this.get(rid);
        if (
          run.status !== "completed" ||
          !run.providers.includes(input.provider)
        )
          throw new ObservationError(
            400,
            "Choose a completed run that includes this provider.",
          );
      }
    if (input.status === "reviewed" && input.conclusion.length < 10)
      throw new ObservationError(
        400,
        "Record what the comparison supports, including uncertainty.",
      );
    const at = new Date().toISOString();
    const experiment: Experiment = {
      ...input,
      id: old?.id || randomUUID(),
      createdAt: old?.createdAt || at,
      updatedAt: at,
    };
    this.store.db
      .prepare(
        "INSERT INTO provider_experiments VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(experiment.id, JSON.stringify(experiment));
    return experiment;
  }
}
