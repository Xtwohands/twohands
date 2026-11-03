import { z } from "zod";
import { config, providerEstimate } from "./config.js";
import type { ToolName } from "./observation-types.js";

export const searchOptions = {
  maxResults: z.number().int().min(1).max(20).optional(),
  searchDepth: z.enum(["basic", "advanced"]).optional(),
};
export const requestDomains = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  )
  .max(10)
  .default([]);
export const costRequest = z
  .object({
    tool: z.enum(["exa_search", "tavily_search", "firecrawl_extract"]),
    query: z.string().trim().min(1).max(500).optional(),
    url: z.string().url().max(2048).optional(),
    domains: requestDomains,
    ...searchOptions,
  })
  .strict()
  .superRefine((r, ctx) => {
    const extraction = r.tool === "firecrawl_extract";
    if (
      extraction
        ? !r.url || r.query !== undefined
        : !r.query || r.url !== undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "Search requires a query; extraction requires a URL.",
      });
    if (
      extraction &&
      (r.maxResults !== undefined ||
        r.searchDepth !== undefined ||
        r.domains.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Search options do not apply to extraction.",
      });
    if (r.tool === "exa_search" && r.searchDepth !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "searchDepth applies only to Tavily; Exa uses auto mode.",
      });
  });
/** One proposed provider request. Never inferred from natural-language task complexity. */
export function estimateRequest(raw: z.input<typeof costRequest>) {
  const r = costRequest.parse(raw);
  const provider = (
    {
      exa_search: "exa",
      tavily_search: "tavily",
      firecrawl_extract: "firecrawl",
    } as const
  )[r.tool];
  const base = providerEstimate(provider);
  const maxResults = r.maxResults ?? 10;
  const depth = r.searchDepth ?? "basic";
  const units = provider === "tavily" && depth === "advanced" ? 2 : 1;
  const extraResults = provider === "exa" ? Math.max(0, maxResults - 10) : 0;
  const estimatedMicros =
    base * units + extraResults * config.exaAdditionalResultMicros;
  const description =
    provider === "exa"
      ? `Auto search, up to ${maxResults} results with page text; base includes 10 results${extraResults ? ` + ${extraResults} additional results` : ""}`
      : provider === "tavily"
        ? `${depth} search, up to ${maxResults} results; ${units} credit${units === 1 ? "" : "s"}`
        : "One page as Markdown; 1 base scrape credit. PDF parsing can add credits; page count is unknown before retrieval.";
  return {
    tool: r.tool as ToolName,
    request: r,
    estimatedMicros,
    breakdown: description,
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
    basis:
      "Request parameters × configured rates. Account discounts and free credits are unknown; this is not an invoice.",
    uncertainty:
      provider === "firecrawl"
        ? "Base page estimate; document parsing can increase usage."
        : "Account-specific billing may differ.",
  };
}
export type RequestEstimate = ReturnType<typeof estimateRequest>;
