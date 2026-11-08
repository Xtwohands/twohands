import { z } from "zod";
import {
  costRequest,
  requestDomains,
  searchOptions,
  estimateRequest,
} from "./request-cost.js";
import { publicEvidenceUrl } from "./url-policy.js";
import type { ToolName } from "./observation-types.js";

export const CATALOG_VERSION = "capabilities-v1";
export const discoveryOperation = z
  .object({
    operation: z.enum(["search", "extract"]),
    query: z.string().trim().min(1).max(500).optional(),
    url: z.string().url().max(2048).optional(),
    domains: requestDomains,
    ...searchOptions,
    content: z
      .enum(["any", "page_text", "complete_page"])
      .default("any")
      .describe(
        "Required output: any allows search excerpts; page_text needs source-page text; complete_page requires untruncated content, which current adapters cannot guarantee.",
      ),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.operation === "search" && r.url !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Search takes a query, not a URL.",
      });
    if (
      r.operation === "extract" &&
      (r.query !== undefined ||
        r.domains.length ||
        r.maxResults !== undefined ||
        r.searchDepth !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Extraction takes a URL, not search parameters.",
      });
  });
export const discoveryInput = z
  .object({
    need: z.string().trim().min(1).max(2000),
    context: z
      .object({
        requirements: z.string().trim().max(4000).default(""),
        evidenceGaps: z
          .array(z.string().trim().min(1).max(600))
          .max(20)
          .default([]),
      })
      .strict()
      .optional()
      .describe(
        "Task-relevant requirements and unresolved evidence gaps. Recorded intent and constraints are included automatically.",
      ),
    operations: z
      .array(discoveryOperation)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Preferred: provider-neutral operations. Octolab discovers compatible tools and prices each alternative; do not preselect a provider.",
      ),
    requests: z
      .array(costRequest)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Legacy provider-specific requests. Octolab also discovers compatible alternatives. Prefer operations for new callers.",
      ),
  })
  .strict();
export type DiscoveryInput = z.input<typeof discoveryInput>;
type Operation = z.infer<typeof discoveryOperation>;

export type DiscoveryMatch = {
  operationIndex: number;
  status:
    | "eligible"
    | "disabled"
    | "unavailable"
    | "over_budget"
    | "incompatible"
    | "needs_parameters";
  reason: string;
};
export type DiscoveryEstimate = ReturnType<typeof estimateRequest> & {
  withinBudget: boolean;
  operationIndex: number;
  origin: "server_matched";
  mappingNotes: string[];
};

/** Deterministic catalog retrieval. Never runs providers or infers prices from prose. */
export function matchTools(
  raw: DiscoveryInput,
  available: Record<ToolName, boolean>,
  remaining: number,
) {
  const input = discoveryInput.parse(raw);
  if (input.operations && input.requests)
    throw new Error("Supply operations or legacy requests, not both.");
  const operations: Operation[] =
    input.operations ??
    (input.requests ?? []).map((r) => ({
      operation: r.tool === "firecrawl_extract" ? "extract" : "search",
      query: r.query,
      url: r.url,
      domains: r.domains,
      maxResults: r.maxResults,
      searchDepth: r.searchDepth,
      content: "any",
    }));
  // Validate every URL before saving discovery context, including incomplete operations.
  for (const op of operations) if (op.url) op.url = publicEvidenceUrl(op.url);
  const tools = (Object.keys(available) as ToolName[]).map((tool) => {
    const matches: DiscoveryMatch[] = [];
    const estimates: DiscoveryEstimate[] = [];
    operations.forEach((op, operationIndex) => {
      const extraction = tool === "firecrawl_extract";
      const mismatch = extraction !== (op.operation === "extract");
      let reason = mismatch
        ? extraction
          ? "Extracts a known URL; does not search for pages."
          : "Searches for pages; does not extract a specified URL."
        : "";
      if (!reason && op.content === "complete_page")
        reason =
          "This adapter can truncate or omit page text and cannot guarantee complete-page content.";
      if (!reason && op.content === "page_text" && tool === "tavily_search")
        reason =
          "This adapter returns excerpts, not source-page text. Exa can supply partial page text; extraction needs a known URL.";
      if (reason) {
        matches.push({ operationIndex, status: "incompatible", reason });
        return;
      }
      if (extraction ? !op.url : !op.query) {
        matches.push({
          operationIndex,
          status: "needs_parameters",
          reason: extraction
            ? "Supply a public HTTPS URL for a request-specific estimate."
            : "Supply a search query for a request-specific estimate.",
        });
        return;
      }
      const request = extraction
        ? { tool, url: op.url }
        : {
            tool,
            query: op.query,
            domains: op.domains,
            maxResults: op.maxResults ?? 10,
            ...(tool === "tavily_search"
              ? { searchDepth: op.searchDepth ?? "basic" }
              : {}),
          };
      const estimate = estimateRequest(request);
      const withinBudget = estimate.estimatedMicros <= remaining;
      estimates.push({
        ...estimate,
        operationIndex,
        origin: "server_matched",
        withinBudget,
        mappingNotes: extraction
          ? [
              "Markdown extraction, up to 20,000 captured characters; full-page completeness is not guaranteed.",
            ]
          : tool === "exa_search"
            ? [
                "Exa auto mode returns up to 2,500 characters of source text per result; text may be absent.",
                ...(op.searchDepth
                  ? [
                      "searchDepth configures Tavily only. Exa uses auto mode; equal retrieval depth or quality is not claimed.",
                    ]
                  : []),
              ]
            : [
                `Tavily ${op.searchDepth ?? "basic"} mode returns excerpts; generated answers and raw content are disabled.`,
              ],
      });
      matches.push({
        operationIndex,
        status: !available[tool]
          ? "unavailable"
          : !withinBudget
            ? "over_budget"
            : "eligible",
        reason: !available[tool]
          ? "Provider credentials are not configured."
          : !withinBudget
            ? "Request estimate exceeds the remaining session budget."
            : extraction
              ? "Retrieves content from the supplied URL."
              : "Searches the supplied query with the requested result count and domain constraints.",
      });
    });
    return { tool, discoveryMatches: matches, requestEstimates: estimates };
  });
  return {
    input,
    operations,
    tools,
    catalogVersion: CATALOG_VERSION,
    missingInputs: operations.length
      ? []
      : [
          "operations: supply operation and query/URL to discover and price relevant alternatives",
        ],
  };
}
