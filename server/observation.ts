import { z } from "zod";
import {
  toolCapabilities,
  providerSelectionGuidance,
} from "./provider-capabilities.js";
import { config, providerEstimate } from "./config.js";
import { search, scrape, ProviderError } from "./providers.js";
import { publicEvidenceUrl } from "./url-policy.js";
import { digest, ObservationStore } from "./observation-store.js";
import type { Store } from "./store.js";
import type { ProviderId } from "./types.js";
import type {
  ObservationSession,
  ObservedCall,
  ToolName,
  Evaluation,
  Outcome,
} from "./observation-types.js";

const text = (max: number) => z.string().trim().min(1).max(max);
export const sessionInput = z
  .object({
    title: text(160),
    objective: text(12000),
    criteria: z
      .array(
        z
          .object({
            text: text(600),
            weight: z.number().int().min(1).max(10).default(1),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    constraints: z.string().max(4000).default(""),
    budgetMicros: z.number().int().min(0).max(5_000_000).default(100000),
    model: text(160).default("Not reported"),
    host: text(100).default("External agent"),
  })
  .strict();
// Research spending is backend policy, never an agent/consumer input.
export const agentSessionInput = sessionInput.omit({ budgetMicros: true });
export const callInput = z
  .object({
    tool: z.enum(["exa_search", "tavily_search", "firecrawl_extract"]),
    requestKey: text(120),
    query: text(500).optional(),
    url: text(2048).optional(),
    domains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .max(10)
      .default([]),
    statedReason: z.string().max(2000).default(""),
  })
  .strict();
export const outcomeInput = z
  .object({
    requestKey: text(120),
    text: text(100000),
    evidenceCallIds: z.array(z.string().uuid()).max(100).default([]),
  })
  .strict();
export const evaluationInput = z
  .object({
    reviewer: z
      .object({
        kind: z.enum(["unspecified", "human_reported", "assistant_reported"]),
        label: text(100).optional(),
      })
      .strict()
      .optional(),
    historical: z.literal(true).optional(),
    outcomeId: z.string().uuid(),
    criteria: z
      .array(
        z
          .object({
            criterionId: z.string().uuid(),
            verdict: z.enum(["pass", "fail", "unknown"]),
            note: text(2000),
            evidenceCallIds: z.array(z.string().uuid()).max(50).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export class ObservationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const names = {
  exa_search: "exa",
  tavily_search: "tavily",
  firecrawl_extract: "firecrawl",
} as const;
export class Observatory {
  db: ObservationStore;
  active = new Set<string>();
  controlledSamples?: () => Partial<
    Record<ProviderId, import("./provider-lab-types.js").ControlledSample>
  >;
  constructor(
    store: Store,
    private adapters = { search, scrape },
    public timestamps = new Map<ProviderId, number[]>(),
  ) {
    this.db = new ObservationStore(store);
  }
  require(id: string) {
    const s = this.db.get(id);
    if (!s) throw new ObservationError(404, "Session not found.");
    return s;
  }
  create(
    input: z.infer<typeof sessionInput>,
    source: ObservationSession["modelSource"],
    backendAuthorized = false,
  ) {
    const data = sessionInput.parse(input);
    if (
      new Set(data.criteria.map((c) => c.text.toLowerCase())).size !==
      data.criteria.length
    )
      throw new ObservationError(400, "Use distinct success criteria.");
    const at = new Date().toISOString();
    const criteria = data.criteria.map((c) => ({ ...c, id: this.db.newId() }));
    const intentHash = digest({
      objective: data.objective,
      criteria,
      constraints: data.constraints,
      budgetMicros: data.budgetMicros,
    });
    const s: ObservationSession = {
      ...data,
      criteria,
      id: this.db.newId(),
      intentHash,
      modelSource: source,
      status: backendAuthorized ? "active" : "awaiting_approval",
      approvedAt: backendAuthorized ? at : null,
      ...(backendAuthorized
        ? { authorizationSource: "backend_policy" as const }
        : {}),
      spentMicros: 0,
      reservedMicros: 0,
      createdAt: at,
      updatedAt: at,
      commercialConsent: false,
      outcomes: [],
      evaluations: [],
      cases: [],
    };
    this.db.transaction(() => {
      this.db.save(s);
      this.db.event(
        s.id,
        "intent_recorded",
        source === "agent_reported" ? "agent_reported" : "workspace_review",
        {
          intentHash,
          objective: s.objective,
          criteria,
          constraints: s.constraints,
          ...(backendAuthorized ? {} : { budgetMicros: s.budgetMicros }),
          model: s.model,
          modelSource: source,
          host: s.host,
        },
      );
      if (backendAuthorized)
        this.db.event(s.id, "intent_authorized", "observed", {
          intentHash: s.intentHash,
          budgetMicros: s.budgetMicros,
          policy: "agent-session-budget-v1",
          authorizationSource: "backend_policy",
        });
    });
    return s;
  }
  createAgentSession(input: z.infer<typeof agentSessionInput>) {
    const data = agentSessionInput.parse(input);
    return this.create(
      { ...data, budgetMicros: config.agentSessionBudgetMicros },
      "agent_reported",
      true,
    );
  }
  approve(id: string, intentHash: string) {
    return this.db.transaction(() => {
      const s = this.require(id);
      if (intentHash !== s.intentHash)
        throw new ObservationError(
          409,
          "The intent does not match the version being approved.",
        );
      if (!s.approvedAt) {
        s.approvedAt = new Date().toISOString();
        s.status = "active";
        s.authorizationSource = "workspace_operator";
        this.db.save(s);
        this.db.event(id, "intent_approved", "workspace_review", {
          intentHash,
          budgetMicros: s.budgetMicros,
          reviewer: "Local workspace operator",
        });
      }
      return s;
    });
  }
  catalog() {
    const calls = this.db.list().flatMap((s) => this.db.calls(s.id));
    const controlled = this.controlledSamples?.() ?? {};
    return (Object.keys(names) as ToolName[]).map((tool) => {
      const provider = names[tool];
      const samples = calls.filter(
        (c) => c.tool === tool && ["succeeded", "failed"].includes(c.status),
      );
      return {
        tool,
        provider,
        ...toolCapabilities[tool],
        available: Boolean(config.keys[provider]),
        estimatedMicros: providerEstimate(provider),
        rateCardVersion: config.rateCardVersion,
        sampleCount: samples.length,
        sampleScope:
          "Completed organic calls across this workspace; includes successes and failures. Controlled tests are excluded. Usage is not quality.",
        controlledTestSample: controlled[provider] ?? null,
        averageLatencyMs:
          samples.length >= 5
            ? Math.round(
                samples.reduce((n, c) => n + (c.latencyMs || 0), 0) /
                  samples.length,
              )
            : null,
        successRate:
          samples.length >= 5
            ? samples.filter((c) => c.status === "succeeded").length /
              samples.length
            : null,
        quality: null,
      };
    });
  }
  discover(id: string, need: string) {
    this.require(id);
    const tools = this.catalog();
    const offerId = this.db.newId();
    this.db.event(id, "tools_offered", "observed", {
      offerId,
      need,
      tools,
      meaning:
        "Returned to the client; does not prove the model considered every option.",
    });
    return {
      offerId,
      tools,
      note: "Choose explicitly. No provider is selected automatically. Performance is local observed execution, not an accuracy benchmark.",
      selectionGuidance: providerSelectionGuidance,
    };
  }
  async execute(id: string, raw: z.infer<typeof callInput>) {
    const input = callInput.parse(raw);
    const provider = names[input.tool];
    if (
      provider === "firecrawl"
        ? !input.url || input.query !== undefined
        : !input.query || input.url !== undefined
    )
      throw new ObservationError(
        400,
        "Search tools require a query; extraction requires a URL.",
      );
    if (input.url) {
      try {
        input.url = publicEvidenceUrl(input.url);
      } catch {
        throw new ObservationError(
          400,
          "Use a public HTTPS URL without credentials or a private address.",
        );
      }
    }
    const signature = digest(input);
    const receipt = this.db.receipt(id, input.requestKey);
    if (receipt) {
      if (receipt.signature !== signature)
        throw new ObservationError(
          409,
          "This request key was used with different arguments.",
        );
      return { ...receipt.call, replayed: true };
    }
    let call!: ObservedCall;
    this.db.transaction(() => {
      const s = this.require(id);
      if (!s.approvedAt)
        throw new ObservationError(
          409,
          "Approve the recorded intent and budget in APILayer before calling providers.",
        );
      if (!config.keys[provider])
        throw new ObservationError(
          409,
          "This provider is not configured on the server.",
        );
      if (this.db.calls(id).length >= 50)
        throw new ObservationError(
          409,
          "Session limit of 50 provider calls reached.",
        );
      const now = Date.now();
      this.timestamps.set(
        provider,
        (this.timestamps.get(provider) || []).filter((t) => now - t < 60000),
      );
      if (this.timestamps.get(provider)!.length >= config.rpm)
        throw new ObservationError(
          429,
          "Provider request limit reached. Try later with the same request key.",
        );
      const estimateMicros = providerEstimate(provider);
      if (s.spentMicros + s.reservedMicros + estimateMicros > s.budgetMicros)
        throw new ObservationError(
          409,
          "This call would exceed the accepted session budget.",
        );
      call = {
        id: this.db.newId(),
        sessionId: id,
        requestKey: input.requestKey,
        tool: input.tool,
        provider,
        arguments:
          provider === "firecrawl"
            ? { url: input.url }
            : { query: input.query, domains: input.domains },
        statedReason: input.statedReason,
        status: "running",
        startedAt: new Date().toISOString(),
        estimateMicros,
      };
      s.reservedMicros += estimateMicros;
      s.status = "active";
      this.db.save(s);
      this.db.saveCall(call, signature);
      if (input.statedReason)
        this.db.event(id, "selection_explanation", "agent_reported", {
          callId: call.id,
          tool: input.tool,
          text: input.statedReason,
          meaning: "Agent-supplied explanation, not private reasoning.",
        });
      this.db.event(id, "tool_called", "observed", {
        callId: call.id,
        tool: input.tool,
        arguments: call.arguments,
        estimateMicros,
        rateCardVersion: config.rateCardVersion,
        selectedBy: "explicit_caller_choice",
      });
      this.timestamps.get(provider)!.push(now);
    });
    this.active.add(call.id);
    const start = Date.now();
    try {
      const result =
        provider === "firecrawl"
          ? await this.adapters.scrape(input.url!)
          : await this.adapters.search(
              provider,
              input.query!,
              input.domains,
              call.id,
            );
      call.result = result as unknown as Record<string, unknown>;
      call.httpStatus = result.httpStatus;
      call.status = "succeeded";
    } catch (error) {
      call.status = "failed";
      call.error =
        error instanceof ProviderError
          ? error.message
          : "Provider request failed.";
      if (error instanceof ProviderError) call.httpStatus = error.httpStatus;
    } finally {
      call.latencyMs = Date.now() - start;
      call.finishedAt = new Date().toISOString();
      try {
        this.db.transaction(() => {
          const s = this.require(id);
          s.reservedMicros -= call.estimateMicros;
          s.spentMicros += call.estimateMicros;
          this.db.save(s);
          this.db.saveCall(call, signature);
          this.db.event(id, "tool_result", "observed", {
            callId: call.id,
            tool: call.tool,
            status: call.status,
            httpStatus: call.httpStatus ?? null,
            latencyMs: call.latencyMs,
            estimatedMicros: call.estimateMicros,
            error: call.error ?? null,
            result: call.result ?? null,
          });
        });
      } finally {
        this.active.delete(call.id);
      }
    }
    return call;
  }
  outcome(id: string, raw: z.infer<typeof outcomeInput>) {
    const input = outcomeInput.parse(raw);
    return this.db.transaction(() => {
      const s = this.require(id);
      if (!s.approvedAt)
        throw new ObservationError(
          409,
          "Intent must be approved before recording an outcome.",
        );
      if (
        s.reservedMicros > 0 ||
        this.db.calls(id).some((c) => c.status === "running")
      )
        throw new ObservationError(
          409,
          "Wait for running tool calls to finish before submitting the outcome.",
        );
      const old = this.db
        .events(id)
        .find(
          (e) =>
            e.type === "outcome_submitted" &&
            e.data.requestKey === input.requestKey,
        );
      if (old) {
        if (old.data.signature !== digest(input))
          throw new ObservationError(
            409,
            "This outcome request key was used with different content.",
          );
        return { ...s, submittedOutcomeId: String(old.data.outcomeId) };
      }
      this.checkEvidence(id, input.evidenceCallIds);
      const outcome: Outcome = {
        id: this.db.newId(),
        at: new Date().toISOString(),
        text: input.text,
        evidenceCallIds: [...new Set(input.evidenceCallIds)],
        source: "agent_reported",
      };
      s.outcomes.push(outcome);
      s.status = "completed";
      this.db.save(s);
      this.db.event(id, "outcome_submitted", "agent_reported", {
        outcomeId: outcome.id,
        requestKey: input.requestKey,
        signature: digest(input),
        text: outcome.text,
        evidenceCallIds: outcome.evidenceCallIds,
        intentHash: s.intentHash,
      });
      return { ...s, submittedOutcomeId: outcome.id };
    });
  }
  checkEvidence(id: string, callIds: string[]) {
    const valid = new Set(this.db.calls(id).map((c) => c.id));
    if (callIds.some((c) => !valid.has(c)))
      throw new ObservationError(
        400,
        "Evidence must reference tool calls in this session.",
      );
  }
  evaluate(id: string, raw: z.infer<typeof evaluationInput>) {
    const input = evaluationInput.parse(raw);
    return this.db.transaction(() => {
      const s = this.require(id);
      const latest = s.outcomes.at(-1);
      if (!s.outcomes.some((o) => o.id === input.outcomeId))
        throw new ObservationError(
          404,
          "Output version not found in this session.",
        );
      if (!input.historical && (!latest || input.outcomeId !== latest.id))
        throw new ObservationError(
          409,
          "Review the latest output version. Reload the session before saving.",
        );
      if (
        input.criteria.length !== s.criteria.length ||
        new Set(input.criteria.map((c) => c.criterionId)).size !==
          s.criteria.length ||
        input.criteria.some(
          (c) => !s.criteria.some((k) => k.id === c.criterionId),
        )
      )
        throw new ObservationError(400, "Review every criterion exactly once.");
      for (const c of input.criteria) this.checkEvidence(id, c.evidenceCallIds);
      let passedWeight = 0,
        failedWeight = 0,
        unknownWeight = 0;
      for (const c of input.criteria) {
        const w = s.criteria.find((k) => k.id === c.criterionId)!.weight;
        if (c.verdict === "pass") passedWeight += w;
        else if (c.verdict === "fail") failedWeight += w;
        else unknownWeight += w;
      }
      const known = passedWeight + failedWeight;
      const total = known + unknownWeight;
      const evaluation: Evaluation = {
        ...input,
        id: this.db.newId(),
        at: new Date().toISOString(),
        intentHash: s.intentHash,
        source: "workspace_review",
        reviewer: input.reviewer ?? { kind: "unspecified" },
        score: known ? Math.round((100 * passedWeight) / known) : null,
        coverage: Math.round((100 * known) / total),
        passedWeight,
        failedWeight,
        unknownWeight,
      };
      s.evaluations.push(evaluation);
      this.db.save(s);
      this.db.event(id, "outcome_evaluated", "workspace_review", {
        ...evaluation,
        reviewerIdentity: "Self-reported; not independently verified",
      });
      return s;
    });
  }
  consent(id: string, consent: boolean) {
    return this.db.transaction(() => {
      const s = this.require(id);
      s.commercialConsent = consent;
      this.db.save(s);
      this.db.event(id, "sharing_consent_changed", "workspace_review", {
        commercialConsent: consent,
        scope:
          "Aggregate tool and outcome statistics only; excludes raw intent, outputs, URLs, and explanations.",
      });
      return s;
    });
  }
  openCase(id: string, evaluationId: string, reason: string) {
    return this.db.transaction(() => {
      const s = this.require(id);
      if (!s.evaluations.some((e) => e.id === evaluationId))
        throw new ObservationError(
          400,
          "Select an evaluation from this session.",
        );
      const at = new Date().toISOString();
      const c = {
        id: this.db.newId(),
        at,
        updatedAt: at,
        evaluationId,
        reason,
        status: "open" as const,
      };
      s.cases.push(c);
      this.db.save(s);
      this.db.event(id, "review_case_opened", "workspace_review", {
        ...c,
        paymentIssued: false,
        coveragePolicy: null,
      });
      return s;
    });
  }
  resolveCase(
    id: string,
    caseId: string,
    status: "resolved" | "dismissed",
    resolution: string,
  ) {
    return this.db.transaction(() => {
      const s = this.require(id);
      const c = s.cases.find((c) => c.id === caseId);
      if (!c) throw new ObservationError(404, "Review case not found.");
      if (c.status !== "open")
        throw new ObservationError(409, "This case has already been closed.");
      c.status = status;
      c.resolution = resolution;
      c.updatedAt = new Date().toISOString();
      this.db.save(s);
      this.db.event(id, "review_case_closed", "workspace_review", {
        caseId,
        status,
        resolution,
        paymentIssued: false,
      });
      return s;
    });
  }
  summary() {
    const sessions = this.db.list();
    const modelNames = [...new Set(sessions.map((s) => s.model))];
    const models = modelNames.map((model) => {
      const group = sessions.filter((s) => s.model === model);
      const reviews = group.flatMap((s) => {
        const e = s.evaluations
          .filter((e) => e.outcomeId === s.outcomes.at(-1)?.id)
          .at(-1);
        return e ? [e] : [];
      });
      const complete = reviews.filter(
        (e) => e.unknownWeight === 0 && e.score !== null,
      );
      return {
        model,
        identity: "Reported, not independently verified",
        sessions: group.length,
        reviewed: reviews.length,
        fullyReviewed: complete.length,
        score:
          complete.length >= 5 && model !== "Not reported"
            ? Math.round(
                complete.reduce((n, e) => n + e.score!, 0) / complete.length,
              )
            : null,
        scoreUnavailableReason:
          model === "Not reported"
            ? "Model identity not reported"
            : complete.length < 5
              ? "Not enough reviews"
              : null,
        assistantReviewed: reviews.filter(
          (e) => e.reviewer?.kind === "assistant_reported",
        ).length,
        humanReportedReviews: reviews.filter(
          (e) => e.reviewer?.kind === "human_reported",
        ).length,
        minimumSamples: 5,
        sampleUnit: "Latest fully reviewed outcome per session",
        reviewSource: "Local workspace operator",
      };
    });
    const sharing = sessions.filter((s) => s.commercialConsent);
    return {
      sessions: sessions.length,
      pendingApproval: sessions.filter((s) => !s.approvedAt).length,
      outputs: sessions.filter((s) => s.outcomes.length).length,
      reviews: sessions.filter((s) =>
        s.evaluations.some((e) => e.outcomeId === s.outcomes.at(-1)?.id),
      ).length,
      estimatedMicros: sessions.reduce((n, s) => n + s.spentMicros, 0),
      openCases: sessions.reduce(
        (n, s) => n + s.cases.filter((c) => c.status === "open").length,
        0,
      ),
      models,
      sharing: {
        consentedSessions: sharing.length,
        minimumCohort: config.minCohort,
        available: this.commercialAggregate().available,
        published: false,
      },
    };
  }
  commercialAggregate() {
    const sessions = this.db.list().filter((s) => s.commercialConsent);
    if (sessions.length < config.minCohort)
      return {
        available: false,
        minimumCohort: config.minCohort,
        consentedSessions: sessions.length,
        providers: [],
      };
    const providers = Object.values(names).flatMap((provider) => {
      const relevant = sessions.filter((s) =>
        this.db.calls(s.id).some((c) => c.provider === provider),
      );
      if (relevant.length < config.minCohort) return [];
      const calls = relevant
        .flatMap((s) => this.db.calls(s.id))
        .filter(
          (c) =>
            c.provider === provider &&
            ["succeeded", "failed"].includes(c.status),
        );
      return [
        {
          provider,
          sessions: relevant.length,
          calls: calls.length,
          successes: calls.filter((c) => c.status === "succeeded").length,
          averageLatencyMs: calls.length
            ? Math.round(
                calls.reduce((n, c) => n + (c.latencyMs || 0), 0) /
                  calls.length,
              )
            : null,
        },
      ];
    });
    return {
      available: providers.length > 0,
      minimumCohort: config.minCohort,
      consentedSessions: sessions.length,
      providers,
      includesRawContent: false,
      automaticallyPublished: false,
    };
  }
}
