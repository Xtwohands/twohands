import { describe, it, expect, vi, afterEach } from "vitest";
import { search, safeUrl } from "../server/providers";
import { config } from "../server/config";
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("official provider adapter contracts", () => {
  it("sends Exa credentials in a header and normalizes cost metadata without claiming billed charges", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              url: "https://example.com",
              title: "Example",
              text: "Source excerpt",
              publishedDate: "2026-10-01",
            },
          ],
          costDollars: { total: 0.015 },
          requestId: "req-1",
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    const r = await search("exa", "a search", ["example.com"], "call-1");
    const [url, options] = mock.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(options.headers["x-api-key"]).toBe(config.keys.exa);
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      query: "a search",
      numResults: 10,
      includeDomains: ["example.com"],
      contents: { text: { maxCharacters: 2500 } },
    });
    expect(body).not.toHaveProperty("api_key");
    expect(r.usage?.providerReportedUsd).toBe(0.015);
    expect(r.usage?.source).toContain("not a reconciled invoice");
    expect(r.sources[0]).toMatchObject({
      provider: "exa",
      callId: "call-1",
      publishedAt: "2026-10-01",
    });
  });
  it("sends Tavily basic search with opt-in usage reporting and never interprets credits as dollars", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              url: "https://example.com",
              title: "Example",
              content: "Evidence",
            },
          ],
          usage: { credits: 1 },
          request_id: "req-2",
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    const r = await search("tavily", "a search", [], "call-2");
    expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
      search_depth: "basic",
      include_usage: true,
      include_answer: false,
    });
    expect(r.usage).toMatchObject({ credits: 1 });
    expect(r.usage).not.toHaveProperty("providerReportedUsd");
  });
  it("ignores non-object and unsafe-URL results and enforces domains after normalization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              null,
              "bad",
              { url: "javascript:alert(1)" },
              { url: "https://example.com.evil.test" },
              { url: "https://sub.example.com", content: "Evidence" },
            ],
          }),
        ),
      ),
    );
    const r = await search("tavily", "a query", ["example.com"], "call");
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].url).toBe("https://sub.example.com/");
  });
  it("rejects credential-bearing links and unsafe schemes", () => {
    expect(safeUrl("https://user:pass@example.com")).toBeUndefined();
    expect(safeUrl("data:text/html,bad")).toBeUndefined();
    expect(safeUrl("https://example.com")).toBe("https://example.com/");
  });
  it("bounds provider payload sizes and never stores raw vendor error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("credential=secret", { status: 401 })),
    );
    await expect(search("exa", "query", [], "c")).rejects.toThrow(
      "Provider returned HTTP 401",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("x".repeat(2_000_001))),
    );
    await expect(search("exa", "query", [], "c")).rejects.toThrow(
      "Provider invalid response",
    );
  });
});
