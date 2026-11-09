/** Stable public identifiers. Add reviewed integrations here and in provider-adapters.ts. */
export const providerTools = {
  exa_search: "exa",
  tavily_search: "tavily",
  firecrawl_extract: "firecrawl",
} as const;
export type RegisteredToolName = keyof typeof providerTools;
export type RegisteredProviderId = (typeof providerTools)[RegisteredToolName];
export const toolIdentifiers = Object.keys(providerTools) as [
  RegisteredToolName,
  ...RegisteredToolName[],
];
