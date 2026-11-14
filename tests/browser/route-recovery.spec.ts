import { expect, test } from "@playwright/test";

test("a failed route download offers reload and recovers the selected page", async ({
  page,
}) => {
  let downloads = 0;
  await page.route(
    /\/assets\/UserDashboardView-[^/]+\.js(?:\?.*)?$/,
    async (route) => {
      if (++downloads === 1) await route.abort("failed");
      else await route.continue();
    },
  );
  await page.goto("/#dashboard/tools");
  await expect(
    page.getByRole("heading", { name: "Unable to load Two Hands" }),
  ).toBeVisible();
  await expect(page.getByText("Reload the page to try again.")).toBeVisible();
  await expect(page).toHaveURL(/#dashboard\/tools$/);

  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tool catalog", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ws-tool-card")).not.toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Unable to load Two Hands" }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/#dashboard\/tools$/);
  expect(downloads).toBeGreaterThanOrEqual(2);
});
