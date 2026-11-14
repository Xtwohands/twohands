import { test, expect } from "@playwright/test";
import { providerIds } from "../../server/provider-catalog";

test("slow successful catalog requests finish without overlapping or discarding results", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/observations/catalog", async (route) => {
    requests++;
    await new Promise((r) => setTimeout(r, 6500));
    await route.continue();
  });
  await page.goto("/#dashboard/tools");
  await expect(
    page.getByRole("status").filter({ hasText: "Loading tools" }),
  ).toBeVisible();
  await expect(page.locator(".ws-tool-card")).toHaveCount(
    providerIds.length - 1,
    { timeout: 12000 },
  );
  expect(requests).toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: "Loading tools" }),
  ).toHaveCount(0);
});

test("catalog does not load usage or activity, and the sidebar requests only a funding summary", async ({
  page,
}) => {
  const paths: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/"))
      paths.push(new URL(req.url()).pathname + new URL(req.url()).search);
  });
  await page.goto("/#dashboard/tools");
  await expect(page.locator(".ws-tool-card")).toHaveCount(
    providerIds.length - 1,
  );
  await expect
    .poll(() => paths.includes("/api/account/funding?summary=true"))
    .toBe(true);
  expect(
    paths.some(
      (p) =>
        p.startsWith("/api/account/usage") ||
        p.startsWith("/api/account/activity"),
    ),
  ).toBe(false);
  expect(paths).not.toContain("/api/observations/connection");
  expect(paths).not.toContain("/api/account/funding");
});
