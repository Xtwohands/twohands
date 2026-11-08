/** TEST PROCESS ONLY. No fixture adapter is imported by server/index.ts. */
import { config } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { FundingService } from "../../server/funding.js";
import { StripeFundingService } from "../../server/stripe-funding.js";
import { FixtureStripeGateway, fixtureStripeSettings } from "./stripe.js";
import { createApp } from "../../server/app.js";
config.keys.exa = "TEST_ONLY_EXA_KEY";
config.keys.tavily = "TEST_ONLY_TAVILY_KEY";
config.keys.firecrawl = "TEST_ONLY_FIRECRAWL_KEY";
config.providerTestDailyBudgetMicros = 50_000_000;
config.rpm = 1000;
if (process.env.FIXTURE_API_KEYS === "true")
  config.token = "fixture-owner-token-0000000000001";
config.adminToken = "fixture-admin-token";
// Test process only: no receiving address or RPC fixture is configured in production.
process.env.DEPOSITS_TESTNET_ENABLED = "true";
process.env.BASE_SEPOLIA_DEPOSIT_ADDRESS = `0x${"22".repeat(20)}`;
process.env.BASE_SEPOLIA_RPC_URL = "https://fixture-base-sepolia.invalid";
// Stable synthetic prices make legacy fallback tests independent of published rate updates.
Object.assign(config.prices, { exa: 17000, tavily: 8000, firecrawl: 1000 });
config.rateCardVersion = "synthetic-browser-fixture-v1";
if (process.env.FIXTURE_EXTRACTION_ONLY === "true") {
  config.keys.exa = "";
  config.keys.tavily = "";
  config.keys.firecrawl = "";
  config.allowKeylessFirecrawl = true;
}
let extractionVersion = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const endpoint = String(input);
  if (endpoint === "https://fixture-base-sepolia.invalid") {
    const { method, params } = JSON.parse(init?.body as string);
    const blockHash = `0x${"44".repeat(32)}`;
    const transactionHash = `0x${"33".repeat(32)}`;
    const result =
      method === "eth_chainId"
        ? "0x14a34"
        : method === "eth_getBlockByNumber"
          ? {
              number: params[0] === "finalized" ? "0x20" : "0x10",
              hash: blockHash,
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
            }
          : method === "eth_getTransactionReceipt"
            ? {
                transactionHash,
                blockHash,
                blockNumber: "0x10",
                status: "0x1",
                logs: [
                  {
                    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                    topics: [
                      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                      `0x${"11".repeat(20).padStart(64, "0")}`,
                      `0x${"22".repeat(20).padStart(64, "0")}`,
                    ],
                    data: `0x${(10000000).toString(16).padStart(64, "0")}`,
                    logIndex: "0x0",
                    blockHash,
                    transactionHash,
                    removed: false,
                  },
                ],
              }
            : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }
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
        data: {
          markdown:
            `TEST FIXTURE extraction evidence. Version ${++extractionVersion}. `.repeat(
              body.url.endsWith("/long") ? 600 : 40,
            ),
          metadata: {
            statusCode: body.url.endsWith("/missing") ? 404 : 200,
            creditsUsed: 1,
            title: "TEST FIXTURE example page",
          },
        },
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
const funding = new FundingService(store);
const stripeGateway = new FixtureStripeGateway();
const stripeFunding = new StripeFundingService(
  funding,
  {
    ...fixtureStripeSettings,
    appUrl: `http://127.0.0.1:${process.env.FIXTURE_PORT || 3102}`,
  },
  stripeGateway,
);
const app = createApp(
  store,
  undefined,
  undefined,
  undefined,
  funding,
  stripeFunding,
);
// Fixture control exists only in this dedicated in-memory test process.
app.post("/__fixture/stripe/:id", async (req, res) => {
  try {
    const intent = stripeFunding.get(String(req.params.id));
    const payment = stripeGateway.pay(
      intent.checkoutSessionId!,
      Number(req.body.refundedCents || 0),
      req.body.disputed === true,
    );
    const event = stripeGateway.signed(
      req.body.disputed
        ? "charge.dispute.created"
        : req.body.refundedCents
          ? "charge.refunded"
          : "checkout.session.completed",
      req.body.disputed
        ? {
            id: `dp_fixture_${intent.id}`,
            object: "dispute",
            charge: payment.payment_intent.latest_charge.id,
            payment_intent: payment.payment_intent.id,
            status: "needs_response",
            livemode: false,
          }
        : req.body.refundedCents
          ? {
              ...payment.payment_intent.latest_charge,
              payment_intent: payment.payment_intent.id,
            }
          : payment,
    );
    const response = await nativeFetch(
      `http://127.0.0.1:${process.env.FIXTURE_PORT || 3102}/api/webhooks/stripe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": event.signature,
        },
        body: event.payload.toString(),
      },
    );
    res.status(response.status).json(await response.json());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
const server = app.listen(
  Number(process.env.FIXTURE_PORT || 3102),
  "127.0.0.1",
  () =>
    console.log(
      "TEST FIXTURE SERVER ONLY: provider network calls intercepted.",
    ),
);
process.on("SIGTERM", () =>
  server.close(() => {
    store.close();
    process.exit(0);
  }),
);
