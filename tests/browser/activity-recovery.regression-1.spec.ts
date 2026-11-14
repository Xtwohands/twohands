import { expect, test } from "@playwright/test";

for (const route of ["dashboard", "dashboard/activity"]) {
  test(`${route} distinguishes unavailable activity from empty history and retries`, async ({
    page,
  }) => {
    let unavailable = true;
    let requests = 0;
    await page.route("**/api/account/activity?*", async (request) => {
      requests++;
      if (unavailable) {
        await request.fulfill({
          status: 503,
          json: { error: "TEST FIXTURE: activity temporarily unavailable" },
        });
      } else {
        await request.fulfill({
          json: { items: [], total: 0, page: 1, pageSize: 20 },
        });
      }
    });
    await page.goto(`/#${route}`);
    await expect(
      page.getByRole("heading", { name: "Activity unavailable", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "activity temporarily unavailable",
    );
    await expect(
      page.getByRole("heading", { name: "No requests yet", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".ws-pagination")).toHaveCount(0);
    const failedRequests = requests;
    unavailable = false;
    await page
      .getByRole("button", { name: "Retry activity", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "No requests yet", exact: true }),
    ).toBeVisible();
    expect(requests).toBeGreaterThan(failedRequests);
    if (route.endsWith("/activity"))
      await expect(page.locator(".ws-pagination")).toContainText("0 requests");
  });
}
