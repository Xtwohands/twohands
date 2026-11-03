import type { ToolName } from "./observation-types.js";

/** Describes this adapter, not every feature sold by the provider. */
export const toolCapabilities: Record<
  ToolName,
  {
    description: string;
    useWhen: string;
    limitations: string;
    documentationUrl: string;
    adapter: Record<string, string | number | boolean>;
  }
> = {
  exa_search: {
    description:
      "Search with Exa auto mode and request up to 2,500 characters of page text per result. Up to 20 results (10 by default); optional domain restriction.",
    useWhen:
      "Use when source text returned with search may answer the question or reduce follow-up page extractions. Compare the returned evidence with the task's needs.",
    limitations:
      "Page text is partial and can be absent. No guarantee of live inventory, complete coverage, or answer accuracy. This adapter does not expose Exa's other search modes.",
    documentationUrl: "https://exa.ai/docs/reference/search",
    adapter: { type: "auto", numResults: 10, textMaxCharacters: 2500 },
  },
  tavily_search: {
    description:
      "Search with Tavily basic mode by default, or advanced mode, for up to 20 ranked results and content excerpts. Optional domain restriction; generated answers and raw page content are disabled.",
    useWhen:
      "Use for finding candidate pages and focused factual lookups when excerpts are sufficient. Retrieve a specific page when the excerpt does not support the needed claim.",
    limitations:
      "Excerpts are not full pages. Per-call estimates do not establish end-to-end task cost or quality. Raw content is not exposed by this adapter.",
    documentationUrl:
      "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    adapter: {
      searchDepth: "basic",
      maxResults: 10,
      includeAnswer: false,
      includeRawContent: false,
    },
  },
  firecrawl_extract: {
    description:
      "Retrieve the main content of one public HTTPS page as Markdown with Firecrawl. Captures up to 20,000 characters and reports truncation and page status when available.",
    useWhen:
      "Use when a known page needs closer inspection, such as a specification, price, or source passage not present in search excerpts.",
    limitations:
      "This is page extraction, not web search. Dynamic options and stock can be incomplete; API success can contain an error page. A truncated receipt is not the full page.",
    documentationUrl:
      "https://docs.firecrawl.dev/api-reference/endpoint/scrape",
    adapter: {
      formats: "markdown",
      onlyMainContent: true,
      captureCharacters: 20000,
    },
  },
};

export const providerSelectionGuidance =
  "Before choosing a provider, call discover_tools with provider-neutral operations: operation, exact query or URL, result count, required content, and relevant options. Include task-relevant requirements and evidence gaps; recorded intent is included automatically. Octolab matches suitable tools and returns comparable request estimates, mapping differences, availability, and evidence-backed reputation. Compare requestEstimates and withinBudget, not generic defaults; re-discover when the request changes. searchDepth configures Tavily only; Exa uses auto mode and equal retrieval depth or quality is not implied. Choose the tool yourself and provide a brief statedReason on every call. Historical usage counts reflect prior selection, not quality; zero calls means unmeasured, not poor. Organic execution, linked outcome reviews, and controlled samples are separate evidence sources. Do not force provider exploration during a consumer task. Controlled comparisons belong in the backend lab. For a simple recommendation, start with one focused search, inspect evidence, and extract only pages needed to resolve material gaps. Add a call only for a specific unresolved need and stop when the answer is supported. Decision summaries are agent-reported, never private reasoning.";
