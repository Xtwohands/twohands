import { expect, test } from "@playwright/test";

const call = {
  id: "fixture-focus-call",
  sessionId: "fixture-focus-session",
  tool: "exa_search",
  provider: "exa",
  status: "succeeded",
  arguments: { query: "TEST FIXTURE keyboard return focus" },
  estimateMicros: 17000,
  latencyMs: 120,
  startedAt: "2026-11-13T21:00:00.000Z",
  finishedAt: "2026-11-13T21:00:00.120Z",
  statedReason: "TEST FIXTURE focus restoration",
  result: { results: [] },
  sessionTitle: "TEST FIXTURE keyboard return focus",
  host: "fixture-client",
  model: "fixture-model",
};

for (const route of ["dashboard", "dashboard/activity"]) {
  test(`${route} request details return keyboard focus to the exact invoking control`, async ({
    page,
  }) => {
    await page.route("**/api/account/activity?*", (request) =>
      request.fulfill({
        json: { items: [call], total: 1, page: 1, pageSize: 20 },
      }),
    );
    await page.route(
      "**/api/observations/fixture-focus-session/calls/fixture-focus-call",
      (request) => request.fulfill({ json: call }),
    );
    await page.goto(`/#${route}`);
    const trigger = page.getByRole("button", {
      name: "Inspect request fixture-focus-call",
      exact: true,
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Request details",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
