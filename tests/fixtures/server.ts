/** TEST PROCESS ONLY. No fixture adapter is imported by server/index.ts. */
import { config } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { createApp } from "../../server/app.js";
config.keys.exa = "TEST_ONLY_EXA_KEY";
config.keys.tavily = "TEST_ONLY_TAVILY_KEY";
config.keys.firecrawl = "TEST_ONLY_FIRECRAWL_KEY";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const endpoint = String(input);
  if (
    ![
      "https://api.exa.ai/search",
      "https://api.tavily.com/search",
      "https://api.firecrawl.dev/v2/scrape",
    ].includes(endpoint)
  )
    return nativeFetch(input, init);
  const body = JSON.parse(init?.body as string);
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (endpoint.includes("firecrawl"))
    return new Response(
      JSON.stringify({
        success: true,
        data: { markdown: "TEST FIXTURE extraction evidence. ".repeat(40) },
      }),
    );
  const exa = endpoint.includes("exa");
  const insufficient = !exa && body.query.includes("stale");
  const results = Array.from({ length: insufficient ? 1 : 3 }, (_, i) => ({
    title: `TEST FIXTURE · ${["Aurora Payments funding announcement", "Aurora Payments product launch", "Boreal Agents company profile"][i]}`,
    url: `https://example.com/fixture-${i + 1}`,
    ...(exa
      ? {
          text: "TEST FIXTURE ONLY. Synthetic evidence used by automated browser tests, never a live provider result. ".repeat(
            4,
          ),
        }
      : {
          content: insufficient
            ? "Stale landing page."
            : "TEST FIXTURE ONLY. Synthetic evidence used by automated browser tests, never a live provider result. ".repeat(
                4,
              ),
        }),
  }));
  return new Response(
    JSON.stringify({
      results,
      ...(exa
        ? { costDollars: { total: 0.015 }, requestId: "test-exa-request" }
        : { usage: { credits: 1 }, request_id: "test-tavily-request" }),
    }),
  );
};
const store = new Store(":memory:");
const server = createApp(store).listen(3102, "127.0.0.1", () =>
  console.log("TEST FIXTURE SERVER ONLY: provider network calls intercepted."),
);
process.on("SIGTERM", () =>
  server.close(() => {
    store.close();
    process.exit(0);
  }),
);
