import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  providerCatalog,
  providerToolNames,
} from "../../server/provider-catalog";

// This fixture server configures every catalog provider with synthetic keys
// and answers each provider endpoint with a response shaped like its real API.
test.use({ baseURL: "http://127.0.0.1:3108", reducedMotion: "reduce" });

const phase1 = [
  { tool: "brave_search", query: "fixture brave" },
  { tool: "parallel_search", query: "fixture parallel" },
  { tool: "perplexity_search", query: "fixture perplexity" },
  { tool: "serper_search", query: "fixture serper" },
  { tool: "linkup_search", query: "fixture linkup" },
  { tool: "parallel_extract", url: "https://example.com/parallel" },
  { tool: "browserbase_extract", url: "https://example.com/browserbase" },
];

test("each Phase 1 tool runs end to end through the observation API", async ({
  request,
}) => {
  const created = await request.post("/api/observations", {
    data: {
      title: "Phase 1 provider fixture",
      objective: "Call every Phase 1 tool once against synthetic responses.",
      criteria: [{ text: "Each tool returns evidence", weight: 1 }],
      constraints: "Synthetic fixture responses only",
      budgetMicros: 60000,
      model: "Fixture agent, not a model",
      host: "Automated test",
    },
  });
  expect(created.status()).toBe(201);
  const session = await created.json();
  await request.post(`/api/observations/${session.id}/approve`, {
    data: { intentHash: session.intentHash },
  });
  for (const call of phase1) {
    const response = await request.post(
      `/api/observations/${session.id}/call`,
      {
        data: {
          ...call,
          requestKey: crypto.randomUUID(),
          statedReason: `Exercise ${call.tool} against its fixture.`,
        },
      },
    );
    expect(response.status(), call.tool).toBe(200);
    const receipt = await response.json();
    const provider = providerCatalog.find((p) => p.tool === call.tool)!.id;
    expect(receipt.provider, call.tool).toBe(provider);
    expect(receipt.status, call.tool).toBe("succeeded");
    const evidence = JSON.stringify(receipt.result);
    expect(evidence, call.tool).toContain("TEST FIXTURE");
    if (call.query) expect(receipt.result.sources, call.tool).toHaveLength(3);
  }
});

test("the tool catalog lists every provider as ready when keys are configured", async ({
  page,
}) => {
  await page.goto("/#dashboard/tools");
  await expect(page.locator(".ws-tool-card")).toHaveCount(
    providerToolNames.length,
  );
  for (const provider of providerCatalog)
    await expect(
      page.locator(".ws-tool-card", { hasText: provider.label }).first(),
    ).toBeVisible();
  await expect(page.getByText("Not configured")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
