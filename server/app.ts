import express from "express";
import { analytics } from "./analytics.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import type { Task } from "./types.js";
import { acceptedOrganizations, resultCsv } from "./results.js";
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "Enter a hostname, such as example.com",
  );
const intentSchema = z.object({
  prompt: z.string().trim().min(10).max(4000),
  query: z.string().trim().min(3).max(500),
  queries: z.array(z.string().trim().min(3).max(500)).min(1).max(5).optional(),
  requiredCount: z.number().int().min(1).max(100),
  budgetMicros: z.number().int().min(1000).max(5_000_000),
  criteria: z
    .array(z.string().trim().min(3).max(160))
    .min(1)
    .max(8)
    .refine((a) => new Set(a).size === a.length, "Criteria must be unique"),
  domains: z.array(domain).max(10),
  mode: z.enum(["route", "compare"]),
  preference: z.enum(["balanced", "cost", "latency"]),
  consent: z.boolean(),
});
function publicTask(t: Task) {
  return {
    id: t.id,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    status: t.status,
    query: t.intent.query,
    spentMicros: t.spentMicros,
    budgetMicros: t.intent.budgetMicros,
    sourceCount: t.sources.length,
  };
}
export function createApp(store: Store, engine = new Engine(store)) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.get("/healthz", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    if (
      !config.token &&
      !["127.0.0.1", "localhost", "[::1]"].includes(req.hostname)
    ) {
      res.status(403).json({
        error:
          "Unrecognized local host. Set API_TOKEN when using a public hostname.",
      });
      return;
    }
    if (config.token) {
      const actual = Buffer.from(
        req.headers.authorization?.replace(/^Bearer /, "") || "",
      );
      const expected = Buffer.from(config.token);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res
          .status(401)
          .json({ error: "Enter the server access token to connect." });
        return;
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (
        origin &&
        (() => {
          try {
            return new URL(origin).host !== req.headers.host;
          } catch {
            return true;
          }
        })()
      ) {
        res.status(403).json({ error: "Cross-origin writes are not allowed" });
        return;
      }
      if (!req.is("application/json")) {
        res.status(415).json({ error: "JSON content type required" });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "24kb" }));
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      providers: engine.available(),
      estimates: config.prices,
      rateCardVersion: config.rateCardVersion,
      policyVersion: config.policyVersion,
      minCohort: config.minCohort,
    }),
  );
  app.get("/api/tasks", (_req, res) => res.json(store.tasks().map(publicTask)));
  app.post("/api/tasks", (req, res) => {
    const parsed = intentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
      return;
    }
    if (store.tasks().length >= 500) {
      res.status(409).json({
        error:
          "Local task limit reached. Apply the retention policy before creating more tasks.",
      });
      return;
    }
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      intent: parsed.data,
      createdAt: now,
      updatedAt: now,
      status: "ready",
      spentMicros: 0,
      reservedMicros: 0,
      sources: [],
      assessments: [],
    };
    store.transaction(() => {
      store.save(task);
      store.event(task.id, "intent_created", {
        ...parsed.data,
        rubricVersion: "user-rubric-v1",
        consentScope: parsed.data.consent
          ? "local task storage and aggregated provider analytics"
          : "local task storage only",
      });
    });
    res.status(201).json(task);
  });
  app.get("/api/tasks/:id", (req, res) => {
    const task = store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({
      ...task,
      events: store.events(task.id),
      organizations: acceptedOrganizations(task),
    });
  });
  app.post("/api/tasks/:id/run", (req, res) => {
    const task = store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const parsed = z
      .object({ query: z.string().trim().min(3).max(500).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query" });
      return;
    }
    if (engine.active.has(task.id)) {
      res
        .status(409)
        .json({ error: "This task already has an operation in progress" });
      return;
    }
    if (engine.active.size >= 3) {
      res.status(429).json({
        error: "Three tasks are already running. Try again when one finishes.",
      });
      return;
    }
    if (
      store.events(task.id).filter((e) => e.type === "provider_request")
        .length >= 50
    ) {
      res.status(409).json({
        error:
          "Task safety cap of 50 paid attempts reached. Create a new task to continue.",
      });
      return;
    }
    const available = engine.available();
    if (!available.exa && !available.tavily) {
      res.status(409).json({
        error:
          "Configure EXA_API_KEY or TAVILY_API_KEY on the server before running live research.",
      });
      return;
    }
    const remaining =
      task.intent.budgetMicros - task.spentMicros - task.reservedMicros;
    if (
      remaining <
      Math.min(
        ...(["exa", "tavily"] as const)
          .filter((p) => available[p])
          .map((p) => config.prices[p]),
      )
    ) {
      res
        .status(409)
        .json({ error: "The remaining task budget cannot cover a search." });
      return;
    }
    engine.active.add(task.id);
    task.status = "running";
    task.error = undefined;
    task.updatedAt = new Date().toISOString();
    store.save(task);
    void engine.execute(
      task.id,
      parsed.data.query ?? task.intent.queries ?? task.intent.query,
    );
    res.status(202).json({ taskId: task.id });
  });
  app.post("/api/tasks/:id/cancel", (req, res) => {
    if (!store.get(req.params.id)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ requested: engine.cancel(req.params.id) });
  });
  app.post("/api/tasks/:id/fetch", async (req, res) => {
    const task = store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const parsed = z
      .object({ sourceId: z.string().uuid() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid source ID" });
      return;
    }
    if (!engine.available().firecrawl) {
      res.status(409).json({ error: "Firecrawl is not configured" });
      return;
    }
    if (engine.active.has(task.id) || engine.active.size >= 3) {
      res.status(409).json({
        error: "An operation is in progress. Try again when it completes.",
      });
      return;
    }
    engine.active.add(task.id);
    const previousStatus = task.status;
    task.status = "running";
    store.save(task);
    try {
      await engine.fetchUrl(task, parsed.data.sourceId);
      res.json({ ok: true });
    } catch (e) {
      res
        .status(400)
        .json({ error: e instanceof Error ? e.message : "Extraction failed" });
    } finally {
      engine.active.delete(task.id);
      engine.cancelled.delete(task.id);
      const fresh = store.get(task.id)!;
      fresh.status = previousStatus;
      fresh.updatedAt = new Date().toISOString();
      store.save(fresh);
    }
  });
  app.post("/api/tasks/:id/assessments", (req, res) => {
    const task = store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const parsed = z
      .object({
        sourceId: z.string().uuid(),
        organization: z.string().trim().max(120),
        criteria: z.record(z.string(), z.enum(["pass", "fail", "unknown"])),
        disposition: z.enum(["accepted", "rejected", "pending"]),
        note: z.string().trim().max(2000),
        evidence: z
          .record(z.string(), z.array(z.string().uuid()).min(1).max(20))
          .optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid assessment" });
      return;
    }
    const a = parsed.data;
    if (
      !task.sources.some((s) => s.id === a.sourceId) ||
      Object.keys(a.criteria).length !== task.intent.criteria.length ||
      task.intent.criteria.some((c) => !Object.hasOwn(a.criteria, c))
    ) {
      res.status(400).json({
        error:
          "Assessment must reference an existing source and every intent criterion",
      });
      return;
    }
    if (
      a.evidence &&
      (Object.keys(a.evidence).some((c) => !task.intent.criteria.includes(c)) ||
        Object.values(a.evidence)
          .flat()
          .some((id) => !task.sources.some((s) => s.id === id)))
    ) {
      res.status(400).json({
        error: "Evidence links must reference this task’s sources and rubric",
      });
      return;
    }
    if (
      a.disposition === "accepted" &&
      (!a.organization ||
        task.intent.criteria.some((c) => a.criteria[c] !== "pass") ||
        !a.note)
    ) {
      res.status(400).json({
        error:
          "Acceptance requires an organization, all criteria passed, and an evidence note",
      });
      return;
    }
    a.evidence = Object.fromEntries(
      task.intent.criteria.map((c) => [c, a.evidence?.[c] || [a.sourceId]]),
    );
    task.assessments = task.assessments
      .filter((v) => v.sourceId !== a.sourceId)
      .concat(a);
    task.updatedAt = new Date().toISOString();
    store.transaction(() => {
      store.save(task);
      store.event(task.id, "user_feedback", {
        ...a,
        evaluator: "human",
        rubricVersion: "user-rubric-v1",
        evidenceRefs: [task.sources.find((s) => s.id === a.sourceId)!.url],
      });
    });
    res.json({ ok: true });
  });
  app.get("/api/tasks/:id/results", (req, res) => {
    const task = store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({
      organizations: acceptedOrganizations(task),
      requiredCount: task.intent.requiredCount,
      reviewType: "human",
      csv: resultCsv(task),
    });
  });
  app.get("/api/tasks/:id/export", (req, res) => {
    const task = store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    // Strict allowlist: no prompts, queries, URLs, content, credentials, organization names or feedback notes.
    const events = store.events(task.id).map((e) => ({
      id: e.id,
      callId: e.callId,
      type: e.type,
      at: e.at,
      ...(e.type === "provider_candidates"
        ? {
            candidates: e.data.candidates.map((c: any) => ({
              provider: c.provider,
              eligible: c.eligible,
              reasons: c.reasons,
              score: c.score,
              components: c.components,
              insufficientData: c.insufficientData,
            })),
          }
        : {}),
      ...Object.fromEntries(
        [
          "invocationId",
          "provider",
          "policyVersion",
          "rateCardVersion",
          "estimateMicros",
          "chargeType",
          "billingStatus",
          "httpStatus",
          "latencyMs",
          "resultCount",
          "success",
          "pass",
          "usable",
          "returned",
          "taskCriteria",
          "status",
          "evaluator",
          "usage",
        ]
          .filter((k) => Object.hasOwn(e.data, k))
          .map((k) => [k, e.data[k]]),
      ),
    }));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="apilayer-${task.id}.json"`,
    );
    res.json({
      schemaVersion: 1,
      scope: "sanitized task summary",
      id: task.id,
      status: task.status,
      spentMicros: task.spentMicros,
      chargeType: "estimate",
      events,
    });
  });
  app.get("/api/analytics", (_req, res) => res.json(analytics(store)));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found" }),
  );
  app.use(
    express.static("dist", {
      setHeaders: (res) =>
        res.setHeader("Cache-Control", "public, max-age=300"),
    }),
  );
  app.get("/{*path}", (_req, res, next) =>
    res.sendFile("index.html", { root: "dist" }, (err) =>
      err ? next(err) : undefined,
    ),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err.type === "entity.too.large"
          ? 413
          : err instanceof SyntaxError
            ? 400
            : 500;
      res.status(status).json({
        error:
          status === 413
            ? "Request too large"
            : status === 400
              ? "Invalid JSON"
              : "Internal server error",
      });
    },
  );
  return app;
}
