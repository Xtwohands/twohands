import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const fixture = "http://127.0.0.1:3102";
test("sidebar pages have independent routes, browser history, and accessible layouts", async ({
  page,
}) => {
  for (const [route, heading] of [
    ["", "My dashboard"],
    ["tools", "Tool catalog"],
    ["activity", "Activity"],
    ["usage", "Usage"],
    ["routing", "Routing"],
    ["connections", "Connections"],
  ]) {
    await page.goto(`/#dashboard${route ? `/${route}` : ""}`);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Loading workspace data…")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/#dashboard/tools");
  if (test.info().project.name === "mobile")
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "User navigation" })
    .getByRole("link", { name: "Routing", exact: true })
    .click();
  await expect(page).toHaveURL(/#dashboard\/routing$/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Tool catalog", exact: true }),
  ).toBeVisible();
});

test("catalog search, capability filters, and tool details", async ({
  page,
}) => {
  await page.goto("/#dashboard/tools");
  await page.getByRole("button", { name: /Extraction/ }).click();
  await expect(page.locator(".ws-tool-card")).toHaveCount(1);
  await expect(page.locator(".ws-tool-card")).toContainText("Firecrawl");
  await page.getByRole("button", { name: "View tool" }).click();
  await expect(page.getByRole("dialog")).toContainText("What to expect");
  await expect(page.getByRole("dialog")).toContainText("firecrawl_extract");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /All tools/ }).click();
  await page.getByRole("textbox", { name: "Search tools" }).fill("tavily");
  await expect(page.locator(".ws-tool-card")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Search tools" })
    .fill("no-such-tool");
  await expect(
    page.getByRole("heading", { name: "No matching tools" }),
  ).toBeVisible();
});

test("route preview is free, capability-aware, and respects server switches", async ({
  page,
  request,
}) => {
  const previous = await (
    await request.get(`${fixture}/api/workspace/routing`)
  ).json();
  await request.post(`${fixture}/api/workspace/routing`, {
    data: { revision: previous.revision, disabledTools: [] },
  });
  const before = await (
    await request.get(`${fixture}/api/observations`)
  ).json();
  try {
    await page.goto(`${fixture}/#dashboard/routing`);
    await page
      .getByRole("textbox", { name: "Preview search query" })
      .fill("test fixture evidence");
    await page
      .getByRole("button", { name: "Preview route", exact: true })
      .click();
    await expect(page.locator(".ws-preview-result")).toContainText(
      "2 eligible tools",
    );
    await page
      .getByRole("combobox", { name: "Required content" })
      .selectOption("page_text");
    await page
      .getByRole("button", { name: "Preview route", exact: true })
      .click();
    await expect(page.locator(".ws-preview-result")).toContainText(
      "1 eligible tool",
    );
    await page.getByRole("switch", { name: "Pause exa_search" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable exa_search" }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("switch", { name: "Enable exa_search" }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Preview route", exact: true })
      .click();
    await expect(page.locator(".ws-preview-result")).toContainText(
      "0 eligible tools",
    );
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Enable exa_search" }),
    ).not.toBeChecked();
    expect(
      (await (await request.get(`${fixture}/api/observations`)).json()).length,
    ).toBe(before.length);
  } finally {
    const current = await (
      await request.get(`${fixture}/api/workspace/routing`)
    ).json();
    await request.post(`${fixture}/api/workspace/routing`, {
      data: {
        revision: current.revision,
        disabledTools: previous.disabledTools,
      },
    });
  }
});

test("fixture requests flow into usage, filters, receipt inspection, and CSV", async ({
  page,
  request,
}) => {
  const session = await (
    await request.post(`${fixture}/api/observations/agent-sessions`, {
      data: {
        title: "Dashboard browser fixture",
        objective: "Verify the tool workspace",
        criteria: [{ text: "Recorded request", weight: 1 }],
        model: "browser-fixture",
        host: "Playwright fixture",
      },
    })
  ).json();
  const call = await (
    await request.post(`${fixture}/api/observations/${session.id}/call`, {
      data: {
        tool: "tavily_search",
        query: `workspace-e2e-${session.id}`,
        requestKey: "browser-call",
        statedReason: "Verify request traceability",
      },
    })
  ).json();
  expect(call.status).toBe("succeeded");
  await page.goto(`${fixture}/#dashboard/activity`);
  await page
    .getByRole("textbox", { name: "Search requests" })
    .fill(`workspace-e2e-${session.id}`);
  await expect(page.locator(".ws-activity-table tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: `Inspect request ${call.id}` })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Verify request traceability",
  );
  await page.getByRole("tab", { name: "Response", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("TEST FIXTURE");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const file = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await file;
  expect(download.suggestedFilename()).toBe("octolab-activity-7d.csv");
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream!) csv += chunk.toString();
  expect(csv).toContain(call.id);
  expect(csv).toContain("tavily_search");
  expect(csv.startsWith("id,sessionId")).toBe(true);
  await page
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("exa");
  await expect(
    page.getByRole("heading", { name: "No matching requests" }),
  ).toBeVisible();
  await page.goto(`${fixture}/#dashboard/usage`);
  await expect(
    page.getByRole("heading", { name: "Cost and reported usage" }),
  ).toBeVisible();
  await expect(page.locator(".ws-table")).toContainText("Tavily");
});

test("connection instructions change with the chosen client", async ({
  page,
}) => {
  await page.goto("/#dashboard/connections");
  await expect(page.locator(".ws-setup-steps")).toContainText(
    "npm run mcp:install -- codex",
  );
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(page.locator(".ws-setup-steps")).toContainText(
    "npm run mcp:install -- claude",
  );
  await page
    .getByRole("button", { name: "Other MCP client", exact: true })
    .click();
  await expect(page.locator(".ws-setup-steps")).toContainText(
    "npm run mcp:install -- project",
  );
});

test("usage charts keep every day visible for longer periods", async ({
  page,
}) => {
  await page.goto("/#dashboard/usage");
  for (const days of [30, 90]) {
    await page
      .getByRole("combobox", { name: "Date range" })
      .selectOption(String(days));
    await expect(page.locator(".ws-bars > div")).toHaveCount(days);
    const layout = await page.locator(".ws-bars").evaluate((bars) => {
      const box = bars.getBoundingClientRect();
      const cells = Array.from(bars.children).map((c) =>
        c.getBoundingClientRect(),
      );
      return {
        widths: cells.map((c) => c.width),
        right: cells.at(-1)!.right,
        boundary: box.right,
      };
    });
    expect(Math.min(...layout.widths)).toBeGreaterThan(0);
    expect(layout.right).toBeLessThanOrEqual(layout.boundary + 1);
  }
});
