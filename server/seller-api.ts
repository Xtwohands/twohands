import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Observatory } from "./observation.js";
import type { ProviderId } from "./types.js";
import { providerRegistry } from "./provider-adapters.js";
import { toolCapabilities } from "./provider-capabilities.js";
import { taskTypes, taskTypeLabels } from "./seller-taxonomy.js";
import {
  analyzeSeller,
  loadSellerData,
  type SellerReportOptions,
} from "./seller-report.js";
import {
  alerts,
  comparePeriods,
  digest,
  exportCsv,
  exportSections,
  findings,
  listingImpact,
  trend,
} from "./seller-insights.js";
import {
  SellerError,
  lintListing,
  listingInput,
  type SellerStore,
} from "./seller-store.js";

const providers = [
  ...new Set(providerRegistry.list().map((a) => a.provider)),
] as [ProviderId, ...ProviderId[]];
const query = z.object({
  days: z.enum(["7", "30", "90"]).default("30"),
  taskType: z.enum(taskTypes).optional(),
  host: z.string().trim().min(1).max(100).optional(),
});

/**
 * Everything a tool company uses after it is onboarded. Every response is aggregate:
 * no objective, query, URL, stated reason, answer or session ID leaves through here.
 *
 * Local mode trusts the single operator. Hosted mode must put company membership
 * checks in front of these routes before exposing them to company accounts.
 */
export function sellerRoutes(
  app: Express,
  obs: Observatory,
  sellers: SellerStore,
) {
  const route =
    (
      fn: (req: Request, res: Response, provider: ProviderId) => Promise<void>,
    ) =>
    async (req: Request, res: Response) => {
      const provider = z.enum(providers).safeParse(req.params.provider);
      if (!provider.success) {
        res.status(404).json({ error: "Unknown tool company." });
        return;
      }
      try {
        await fn(req, res, provider.data);
      } catch (e) {
        if (e instanceof z.ZodError)
          res.status(400).json({
            error: e.issues[0]?.message ?? "Invalid request.",
            field: e.issues[0]?.path.join(".") || undefined,
          });
        else if (e instanceof SellerError)
          res.status(e.status).json({ error: e.message });
        else res.status(500).json({ error: "Seller request failed." });
      }
    };
  /** Loads once per request and applies the seller's own settings and the naming rule. */
  async function context(req: Request, provider: ProviderId) {
    const q = query.parse(req.query);
    const settings = await sellers.settings(provider);
    const agreed = new Set<string>();
    for (const p of providers)
      if (p !== provider && (await sellers.settings(p)).namedComparison)
        agreed.add(p);
    const options: SellerReportOptions = {
      days: Number(q.days),
      // Named comparison is mutual: both companies must have agreed.
      named: settings.namedComparison,
      canName: (p) => agreed.has(p),
      taskType: q.taskType,
      host: q.host,
      internalHosts: await sellers.internalHosts(),
    };
    const simulation = await obs.db.store.db
      .prepare("SELECT body FROM workspace_settings WHERE key='simulation'")
      .get();
    return {
      data: await loadSellerData(obs),
      settings,
      options,
      simulated: simulation
        ? (JSON.parse(simulation.body as string) as { note: string })
        : null,
    };
  }
  const base = "/api/seller/:provider";

  app.get(
    `${base}/overview`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      const compared = comparePeriods(c.data, provider, c.options);
      const found = findings(compared.current);
      const listings = await sellers.listings(provider);
      const { current } = compared;
      res.json({
        provider,
        providerName: current.providerName,
        simulated: c.simulated,
        window: current.window,
        funnel: current.funnel,
        change: compared.change,
        dataQuality: current.dataQuality,
        alerts: alerts(current, compared.previous, c.settings.alerts),
        findings: found.slice(0, 3),
        findingCount: found.length,
        trend: trend(current, current.days > 30 ? "week" : "day"),
        listing: {
          liveVersion: listings.find((l) => l.status === "live")?.version ?? 0,
          pendingVersion:
            listings.find((l) => l.status === "pending")?.version ?? null,
        },
        namedComparison: c.settings.namedComparison,
        filters: {
          taskTypes: taskTypes.map((t) => ({
            key: t,
            label: taskTypeLabels[t],
          })),
          hosts: current.hosts.map((h) => h.key),
        },
      });
    }),
  );
  app.get(
    `${base}/report`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      res.json({
        ...analyzeSeller(c.data, provider, c.options),
        simulated: c.simulated,
      });
    }),
  );
  app.get(
    `${base}/trend`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      const bucket = z.enum(["day", "week"]).parse(req.query.bucket ?? "day");
      const a = analyzeSeller(c.data, provider, c.options);
      res.json({
        window: a.window,
        bucket,
        minSample: a.minSample,
        points: trend(a, bucket),
      });
    }),
  );
  app.get(
    `${base}/findings`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      res.json({
        findings: findings(analyzeSeller(c.data, provider, c.options)),
      });
    }),
  );
  app.get(
    `${base}/alerts`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      const compared = comparePeriods(c.data, provider, c.options);
      res.json({
        window: compared.current.window,
        thresholds: c.settings.alerts,
        change: compared.change,
        alerts: alerts(compared.current, compared.previous, c.settings.alerts),
      });
    }),
  );
  app.get(
    `${base}/digest`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      const compared = comparePeriods(c.data, provider, c.options);
      const summary = digest(
        compared,
        findings(compared.current),
        alerts(compared.current, compared.previous, c.settings.alerts),
      );
      if (req.query.format === "text")
        res.type("text/plain").send(summary.text);
      else res.json(summary);
    }),
  );
  app.get(
    `${base}/listing-impact`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      res.json(
        listingImpact(c.data, provider, await sellers.listings(provider), {
          ...c.options,
          days: 90,
        }),
      );
    }),
  );
  app.get(
    `${base}/export`,
    route(async (req, res, provider) => {
      const c = await context(req, provider);
      const section = z.enum(exportSections).parse(req.query.section);
      res
        .type("text/csv")
        .attachment(`${provider}-${section}-${c.options.days}d.csv`)
        .send(exportCsv(analyzeSeller(c.data, provider, c.options), section));
    }),
  );
  app.get(
    `${base}/listing`,
    route(async (_req, res, provider) => {
      const listings = await sellers.listings(provider);
      const tool = providerRegistry.list().find((a) => a.provider === provider)!
        .tool as keyof typeof toolCapabilities;
      const builtIn = toolCapabilities[tool];
      const live = listings.find((l) => l.status === "live");
      res.json({
        tool,
        // What agents are shown right now.
        current: {
          version: live?.version ?? 0,
          description: live?.description ?? builtIn.description,
          useWhen: live?.useWhen ?? builtIn.useWhen,
          limitations: live?.limitations ?? builtIn.limitations,
        },
        pending: listings.find((l) => l.status === "pending") ?? null,
        history: listings,
        limits: { description: 600, useWhen: 400, limitations: 600 },
      });
    }),
  );
  app.post(
    `${base}/listing/check`,
    route(async (req, res, provider) => {
      const input = listingInput.parse(req.body);
      const problems = lintListing(provider, input);
      res.json({ ok: !problems.length, problems });
    }),
  );
  app.post(
    `${base}/listing`,
    route(async (req, res, provider) => {
      res.status(201).json(await sellers.submitListing(provider, req.body));
    }),
  );
  app.post(
    `${base}/listing/withdraw`,
    route(async (req, res, provider) => {
      const { version } = z
        .object({ version: z.number().int().min(1) })
        .strict()
        .parse(req.body);
      res.json(await sellers.withdrawListing(provider, version));
    }),
  );
  // A reviewer's action. In hosted mode this belongs to platform administrators only.
  app.post(
    `${base}/listing/review`,
    route(async (req, res, provider) => {
      res.json(await sellers.reviewListing(provider, req.body));
    }),
  );
  app.get(
    `${base}/settings`,
    route(async (_req, res, provider) => {
      res.json(await sellers.settings(provider));
    }),
  );
  for (const method of ["put", "post"] as const)
    app[method](
      `${base}/settings`,
      route(async (req, res, provider) => {
        res.json(await sellers.updateSettings(provider, req.body));
      }),
    );
  app.get(
    `${base}/history`,
    route(async (_req, res, provider) => {
      res.json({ events: await sellers.events(provider) });
    }),
  );
  app.get("/api/seller-admin/internal-hosts", async (_req, res) => {
    res.json({ hosts: await sellers.internalHosts() });
  });
  app.put("/api/seller-admin/internal-hosts", async (req, res) => {
    try {
      res.json({ hosts: await sellers.setInternalHosts(req.body?.hosts) });
    } catch {
      res.status(400).json({ error: "Send up to 50 host names." });
    }
  });
}
