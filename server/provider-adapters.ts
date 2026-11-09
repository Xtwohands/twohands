import { z } from "zod";
import { config, providerEstimate } from "./config.js";
import { capabilityData } from "./provider-capability-data.js";
import {
  AdapterRegistry,
  adapterInput,
  type AdapterDefinition,
  type AdapterQuote,
  type AdapterRequest,
} from "./provider-registry.js";
import type { ToolName } from "./observation-types.js";
import type { ProviderId } from "./types.js";
import { providerTools } from "./provider-identifiers.js";

const nonnegative = z.number().finite().nonnegative();
const status = z.number().int().min(100).max(599);
const usage = z.object({
  providerReportedUsd: nonnegative.optional(),
  credits: nonnegative.optional(),
  source: z.string(),
});
const searchResult = (provider: ProviderId) =>
  z.object({
    sources: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        url: z.string().url(),
        snippet: z.string(),
        publishedAt: z.string().optional(),
        provider: z.literal(provider),
        callId: z.string().nullable(),
      }),
    ),
    httpStatus: status,
    requestId: z.string().optional(),
    usage: usage.optional(),
  });
const extractResult = z.object({
  text: z.string().max(20000),
  httpStatus: status,
  truncated: z.boolean().optional(),
  originalCharacters: nonnegative.optional(),
  returnedCharacters: nonnegative.optional(),
  credits: nonnegative.optional(),
  pageStatus: status.optional(),
  title: z.string().optional(),
  requestId: z.string().optional(),
});
const basis =
  "Request parameters × configured rates. Account discounts and free credits are unknown; this is not an invoice.";
function quote(provider: ProviderId, request: AdapterRequest): AdapterQuote {
  const base = providerEstimate(provider),
    maxResults = request.maxResults ?? 10,
    depth = request.searchDepth ?? "basic";
  const units = provider === "tavily" && depth === "advanced" ? 2 : 1;
  const extra = provider === "exa" ? Math.max(0, maxResults - 10) : 0;
  return {
    estimatedMicros: base * units + extra * config.exaAdditionalResultMicros,
    breakdown:
      provider === "exa"
        ? `Auto search, up to ${maxResults} results with page text; base includes 10 results${extra ? ` + ${extra} additional results` : ""}`
        : provider === "tavily"
          ? `${depth} search, up to ${maxResults} results; ${units} credit${units === 1 ? "" : "s"}`
          : "One page as Markdown; 1 base scrape credit. PDF parsing can add credits; page count is unknown before retrieval.",
    rates: {
      baseMicros: base,
      ...(provider === "exa"
        ? { additionalResultMicros: config.exaAdditionalResultMicros }
        : {}),
    },
    units: provider === "exa" ? null : units,
    unit: provider === "exa" ? "request plus additional results" : "credits",
    rateCardVersion: config.rateCardVersion,
    pricingSource:
      provider === "exa"
        ? "https://exa.ai/pricing"
        : provider === "tavily"
          ? "https://docs.tavily.com/documentation/api-credits"
          : "https://docs.firecrawl.dev/billing",
    pricingCheckedAt: "2026-11-02",
    basis,
    uncertainty:
      provider === "firecrawl"
        ? "Base page estimate; document parsing can increase usage."
        : "Account-specific billing may differ.",
  };
}
/** Only these reviewed server-side definitions are executable in production. */
const definitions: AdapterDefinition<ToolName, ProviderId>[] = [
  {
    tool: "exa_search",
    provider: "exa",
    version: "1.0.0",
    environment: "production",
    operation: "search",
    pageText: true,
    searchDepth: false,
    capabilities: capabilityData.exa_search,
    credential: {
      reference: "EXA_API_KEY",
      resolve: () => config.keys.exa,
      accountReference: () => process.env.EXA_ACCOUNT_REFERENCE,
    },
    input: adapterInput("search"),
    result: searchResult("exa"),
    estimate: (r) => quote("exa", r),
    mappingNotes: (r) => [
      "Exa auto mode returns up to 2,500 characters of source text per result; text may be absent.",
      ...(r.searchDepth
        ? [
            "searchDepth configures Tavily only. Exa uses auto mode; equal retrieval depth or quality is not claimed.",
          ]
        : []),
    ],
    execute: (r, c) =>
      c.transports.search(
        "exa",
        r.query!,
        r.domains,
        c.callId,
        ...(r.maxResults !== undefined ? [{ maxResults: r.maxResults }] : []),
      ),
  },
  {
    tool: "tavily_search",
    provider: "tavily",
    version: "1.0.0",
    environment: "production",
    operation: "search",
    pageText: false,
    searchDepth: true,
    capabilities: capabilityData.tavily_search,
    credential: {
      reference: "TAVILY_API_KEY",
      resolve: () => config.keys.tavily,
      accountReference: () => process.env.TAVILY_ACCOUNT_REFERENCE,
    },
    input: adapterInput("search", true),
    result: searchResult("tavily"),
    estimate: (r) => quote("tavily", r),
    mappingNotes: (r) => [
      `Tavily ${r.searchDepth ?? "basic"} mode returns excerpts; generated answers and raw content are disabled.`,
    ],
    execute: (r, c) =>
      c.transports.search(
        "tavily",
        r.query!,
        r.domains,
        c.callId,
        ...(r.maxResults !== undefined || r.searchDepth !== undefined
          ? [{ maxResults: r.maxResults, searchDepth: r.searchDepth }]
          : []),
      ),
  },
  {
    tool: "firecrawl_extract",
    provider: "firecrawl",
    version: "1.0.0",
    environment: "production",
    operation: "extract",
    pageText: true,
    searchDepth: false,
    capabilities: capabilityData.firecrawl_extract,
    credential: {
      reference: "FIRECRAWL_API_KEY",
      resolve: () => config.keys.firecrawl,
      accountReference: () => process.env.FIRECRAWL_ACCOUNT_REFERENCE,
    },
    input: adapterInput("extract"),
    result: extractResult,
    estimate: (r) => quote("firecrawl", r),
    mappingNotes: () => [
      "Markdown extraction, up to 20,000 captured characters; full-page completeness is not guaranteed.",
    ],
    execute: (r, c) => c.transports.scrape(r.url!),
  },
];
export const providerRegistry = new AdapterRegistry(definitions);
if (
  Object.entries(providerTools).some(
    ([tool, provider]) =>
      !definitions.some((a) => a.tool === tool && a.provider === provider),
  )
)
  throw new Error("A registered identifier is missing its adapter definition.");
export const registeredToolNames = definitions.map((a) => a.tool) as [
  ToolName,
  ...ToolName[],
];
export const registeredProviderIds = definitions.map((a) => a.provider) as [
  ProviderId,
  ...ProviderId[],
];
export const registeredToolSchema = z.enum(registeredToolNames);
export const registeredProviderSchema = z.enum(registeredProviderIds);
