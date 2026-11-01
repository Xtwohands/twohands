import { randomUUID } from "node:crypto";
import { config, providerAuthMode } from "./config.js";
import type { ProviderId, Source } from "./types.js";
export class ProviderError extends Error {
  constructor(
    public kind:
      "timeout" | "http" | "network" | "invalid_response" | "human_required",
    public httpStatus?: number,
  ) {
    super(
      kind === "human_required"
        ? "Keyless allowance unavailable. Sign in to Firecrawl and configure a server-side key to continue; no automatic retry was made."
        : kind === "http"
          ? `Provider returned HTTP ${httpStatus}`
          : `Provider ${kind.replace("_", " ")}`,
    );
  }
}
export function safeUrl(value: unknown): string | undefined {
  try {
    const u = new URL(String(value));
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
export async function search(
  provider: "exa" | "tavily",
  query: string,
  domains: string[],
  callId: string,
): Promise<{
  sources: Source[];
  httpStatus: number;
  requestId?: string;
  usage?: { providerReportedUsd?: number; credits?: number; source: string };
}> {
  const exa = provider === "exa";
  const body = exa
    ? {
        query,
        numResults: 10,
        type: "auto",
        contents: { text: { maxCharacters: 2500 } },
        ...(domains.length ? { includeDomains: domains } : {}),
      }
    : {
        query,
        max_results: 10,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_usage: true,
        ...(domains.length ? { include_domains: domains } : {}),
      };
  const { response, json } = await request(
    exa ? "https://api.exa.ai/search" : "https://api.tavily.com/search",
    provider,
    body,
  );
  if (!Array.isArray(json.results))
    throw new ProviderError("invalid_response", response.status);
  const sources: Source[] = json.results.slice(0, 10).flatMap((r: any) => {
    if (!r || typeof r !== "object") return [];
    const url = safeUrl(r.url);
    if (!url) return [];
    // Enforce normalized domain policy even if the vendor ignores its filter.
    if (
      domains.length &&
      !domains.some(
        (d) =>
          new URL(url).hostname === d ||
          new URL(url).hostname.endsWith(`.${d}`),
      )
    )
      return [];
    return [
      {
        id: randomUUID(),
        title: clean(r.title, 500) || new URL(url).hostname,
        url,
        snippet: clean(exa ? r.text : r.content, 5000),
        ...(typeof r.publishedDate === "string"
          ? { publishedAt: r.publishedDate.slice(0, 40) }
          : {}),
        provider,
        callId,
      },
    ];
  });
  const usage =
    exa &&
    typeof json.costDollars?.total === "number" &&
    Number.isFinite(json.costDollars.total) &&
    json.costDollars.total >= 0
      ? {
          providerReportedUsd: json.costDollars.total,
          source: "provider response; not a reconciled invoice",
        }
      : !exa &&
          typeof json.usage?.credits === "number" &&
          Number.isFinite(json.usage.credits) &&
          json.usage.credits >= 0
        ? {
            credits: json.usage.credits,
            source: "provider response; credits are not USD charges",
          }
        : undefined;
  return {
    sources,
    usage,
    httpStatus: response.status,
    requestId:
      clean(
        json.requestId ??
          json.request_id ??
          response.headers.get("x-request-id"),
        200,
      ) || undefined,
  };
}
export async function scrape(url: string): Promise<{
  text: string;
  truncated?: boolean;
  originalCharacters?: number;
  returnedCharacters?: number;
  httpStatus: number;
  credits?: number;
  pageStatus?: number;
  title?: string;
}> {
  const { response, json } = await request(
    "https://api.firecrawl.dev/v2/scrape",
    "firecrawl",
    { url, formats: ["markdown"], onlyMainContent: true },
  );
  if (json.success !== true || typeof json.data?.markdown !== "string")
    throw new ProviderError("invalid_response", response.status);
  return {
    text: json.data.markdown.slice(0, 20000),
    truncated: json.data.markdown.length > 20000,
    originalCharacters: json.data.markdown.length,
    returnedCharacters: Math.min(json.data.markdown.length, 20000),
    httpStatus: response.status,
    pageStatus:
      Number.isInteger(json.data?.metadata?.statusCode) &&
      json.data.metadata.statusCode >= 100 &&
      json.data.metadata.statusCode <= 599
        ? json.data.metadata.statusCode
        : undefined,
    title: clean(json.data?.metadata?.title, 500) || undefined,
    credits:
      typeof json.data?.metadata?.creditsUsed === "number" &&
      Number.isFinite(json.data.metadata.creditsUsed) &&
      json.data.metadata.creditsUsed >= 0
        ? json.data.metadata.creditsUsed
        : undefined,
  };
}
async function request(endpoint: string, provider: ProviderId, body: unknown) {
  let response: Response;
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider === "exa"
          ? { "x-api-key": config.keys[provider] }
          : providerAuthMode(provider) === "keyless"
            ? {}
            : { Authorization: `Bearer ${config.keys[provider]}` }),
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
  } catch (e) {
    throw new ProviderError(
      e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name)
        ? "timeout"
        : "network",
    );
  }
  // Never reflect vendor error bodies: they may contain credentials or user input.
  if (!response.ok) {
    await response.body?.cancel();
    if (
      providerAuthMode(provider) === "keyless" &&
      [401, 403, 429].includes(response.status)
    )
      throw new ProviderError("human_required", response.status);
    throw new ProviderError("http", response.status);
  }
  try {
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
    const json = JSON.parse(Buffer.concat(chunks).toString());
    if (!json || typeof json !== "object") throw new Error("Invalid response");
    return { response, json };
  } catch {
    throw new ProviderError(
      signal.aborted ? "timeout" : "invalid_response",
      response.status,
    );
  }
}
