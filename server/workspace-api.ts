import { ApiKeyError } from "./api-keys.js";
import type { Express } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { connections } from "./observation-connections.js";
import { Observatory, ObservationError } from "./observation.js";
import { discoveryInput } from "./tool-discovery.js";
import type { ActivityItem, WorkspaceUsage } from "./workspace-types.js";

const period = z.coerce
  .number()
  .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
  .default(7);
const nonnegative = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function workspaceActivity(
  obs: Observatory,
  since: string,
): ActivityItem[] {
  return obs.db
    .list()
    .flatMap((session) =>
      obs.db
        .calls(session.id)
        .filter((call) => call.startedAt >= since)
        .map(({ result, ...call }) => {
          const usage = result?.usage as Record<string, unknown> | undefined;
          return {
            ...call,
            sessionTitle: session.title,
            host: session.host,
            model: session.model,
            reportedUsd: nonnegative(usage?.providerReportedUsd),
            reportedCredits: nonnegative(usage?.credits ?? result?.credits),
          };
        }),
    )
    .sort(
      (a, b) =>
        b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    );
}

export function workspaceUsage(
  items: ActivityItem[],
  days: number,
  since: string,
): WorkspaceUsage {
  const usd = items.filter((i) => i.reportedUsd !== null);
  const timed = items.filter((i) => typeof i.latencyMs === "number");
  return {
    days,
    since,
    requests: items.length,
    succeeded: items.filter((i) => i.status === "succeeded").length,
    failed: items.filter((i) => i.status === "failed").length,
    interrupted: items.filter((i) => i.status === "interrupted").length,
    running: items.filter((i) => i.status === "running").length,
    estimatedMicros: items.reduce(
      (sum, i) => sum + (i.status === "running" ? 0 : i.estimateMicros),
      0,
    ),
    reportedUsd: usd.length
      ? usd.reduce((sum, i) => sum + i.reportedUsd!, 0)
      : null,
    usdReportingCalls: usd.length,
    averageLatencyMs: timed.length
      ? Math.round(
          timed.reduce((sum, i) => sum + i.latencyMs!, 0) / timed.length,
        )
      : null,
    latencySamples: timed.length,
    series: Array.from({ length: days }, (_, n) => {
      const date = new Date(Date.parse(since) + n * 86400000)
        .toISOString()
        .slice(0, 10);
      const calls = items.filter((i) => i.startedAt.slice(0, 10) === date);
      return {
        date,
        requests: calls.length,
        estimatedMicros: calls.reduce(
          (sum, i) => sum + (i.status === "running" ? 0 : i.estimateMicros),
          0,
        ),
      };
    }),
    providers: ["exa", "tavily", "firecrawl"].map((provider) => {
      const calls = items.filter((i) => i.provider === provider);
      const reported = calls.filter((i) => i.reportedCredits !== null);
      return {
        provider,
        requests: calls.length,
        estimatedMicros: calls.reduce(
          (sum, i) => sum + (i.status === "running" ? 0 : i.estimateMicros),
          0,
        ),
        reportedCredits: reported.length
          ? reported.reduce((sum, i) => sum + i.reportedCredits!, 0)
          : null,
        creditReportingCalls: reported.length,
      };
    }),
  };
}

export function workspaceRoutes(app: Express, obs: Observatory) {
  const route =
    (
      fn: (
        req: import("express").Request,
        res: import("express").Response,
      ) => unknown,
    ) =>
    (req: import("express").Request, res: import("express").Response) => {
      try {
        fn(req, res);
      } catch (error) {
        if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: error.issues.map((i) => i.message).join("; ") });
        else if (
          error instanceof ObservationError ||
          error instanceof ApiKeyError
        )
          res.status(error.status).json({ error: error.message });
        else res.status(500).json({ error: "Workspace operation failed." });
      }
    };
  const since = (days: number) => {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - days + 1);
    return start.toISOString();
  };
  app.get(
    "/api/workspace/routing",
    route((_req, res) => res.json(obs.routingPolicy())),
  );
  app.post(
    "/api/workspace/routing",
    route((req, res) => res.json(obs.updateRoutingPolicy(req.body))),
  );
  app.post(
    "/api/workspace/preview",
    route((req, res) =>
      res.json(
        obs.preview(discoveryInput.parse(req.body), res.locals.apiKeyId),
      ),
    ),
  );
  app.get(
    "/api/workspace/usage",
    route((req, res) => {
      const days = period.parse(req.query.days);
      const start = since(days);
      res.json(workspaceUsage(workspaceActivity(obs, start), days, start));
    }),
  );
  app.get(
    "/api/workspace/activity",
    route((req, res) => {
      const input = z
        .object({
          days: period,
          provider: z
            .enum(["all", "exa", "tavily", "firecrawl"])
            .default("all"),
          status: z
            .enum(["all", "succeeded", "failed", "interrupted", "running"])
            .default("all"),
          q: z.string().max(500).default(""),
          page: z.coerce.number().int().min(1).max(100000).default(1),
          export: z.literal("true").optional(),
        })
        .parse(req.query);
      const query = input.q.trim().toLowerCase();
      const items = workspaceActivity(obs, since(input.days)).filter(
        (i) =>
          (input.provider === "all" || i.provider === input.provider) &&
          (input.status === "all" || i.status === input.status) &&
          (!query ||
            `${i.sessionTitle} ${i.tool} ${i.arguments.query ?? i.arguments.url ?? ""} ${i.host}`
              .toLowerCase()
              .includes(query)),
      );
      if (input.export && items.length > 10000)
        throw new ObservationError(
          413,
          "Exports support up to 10,000 requests. Narrow the date range or filters.",
        );
      res.json({
        items: input.export
          ? items
          : items.slice((input.page - 1) * 20, input.page * 20),
        total: items.length,
        page: input.page,
        pageSize: input.export ? items.length : 20,
      });
    }),
  );
  app.get(
    "/api/workspace/connection",
    route((_req, res) =>
      res.json({
        clients: connections(obs.db),
        providers: Object.fromEntries(
          Object.entries(config.keys).map(([name, key]) => [
            name,
            Boolean(key),
          ]),
        ),
        sessionBudgetMicros: config.agentSessionBudgetMicros,
        requestsPerMinute: config.rpm,
        routing: "explicit_agent_selection",
        heartbeat: false,
      }),
    ),
  );
}
