import { createHash } from "node:crypto";
import type { ProviderId } from "./types.js";
function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}
function price(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < 0 || n > 10)
    throw new Error(`Invalid ${name}`);
  return Math.ceil(n * 1_000_000);
}
const prices: Record<ProviderId, number> = {
  // Auto search, <=10 results with page text: published $7/1k, checked 2026-11-01.
  exa: price("EXA_SEARCH_USD", 0.007),
  tavily: price("TAVILY_SEARCH_USD", 0.008),
  firecrawl: price("FIRECRAWL_SCRAPE_USD", 0.001),
};
const exaAdditionalResultMicros = price("EXA_ADDITIONAL_RESULT_USD", 0.001);
export const config = {
  exaAdditionalResultMicros,
  port: integer("PORT", 3001, 1, 65535),
  host: process.env.HOST || "127.0.0.1",
  token: process.env.API_TOKEN || "",
  dbPath: process.env.DB_PATH || "./data/apilayer.sqlite",
  keylessMaxRequests: integer("FIRECRAWL_KEYLESS_MAX_REQUESTS", 10, 1, 50),
  allowKeylessFirecrawl: process.env.FIRECRAWL_ALLOW_KEYLESS === "true",
  timeoutMs: integer("PROVIDER_TIMEOUT_MS", 20000, 100, 120000),
  rpm: integer("PROVIDER_RPM", 20, 1, 1000),
  agentSessionBudgetMicros: integer(
    "AGENT_SESSION_BUDGET_MICROS",
    100000,
    0,
    5_000_000,
  ),
  providerTestBudgetMicros: integer(
    "PROVIDER_TEST_BUDGET_MICROS",
    150000,
    0,
    5_000_000,
  ),
  providerTestDailyBudgetMicros: integer(
    "PROVIDER_TEST_DAILY_BUDGET_MICROS",
    500000,
    0,
    50_000_000,
  ),
  minCohort: integer("ANALYTICS_MIN_TASKS", 5, 5, 10000),
  prices,
  keys: {
    exa: process.env.EXA_API_KEY || "",
    tavily: process.env.TAVILY_API_KEY || "",
    firecrawl: process.env.FIRECRAWL_API_KEY || "",
  } as Record<ProviderId, string>,
  rateCardVersion: `request-estimates-v2:${createHash("sha256").update(JSON.stringify({ prices, exaAdditionalResultMicros })).digest("hex").slice(0, 12)}`,
  policyVersion: "deterministic-v1",
};

export function providerEstimate(provider: ProviderId) {
  return provider === "firecrawl" &&
    !config.keys.firecrawl &&
    config.allowKeylessFirecrawl
    ? 0
    : config.prices[provider];
}
export function providerAuthMode(provider: ProviderId) {
  return provider === "firecrawl" &&
    !config.keys.firecrawl &&
    config.allowKeylessFirecrawl
    ? "keyless"
    : "api-key";
}
