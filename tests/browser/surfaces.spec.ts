import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("public site, user dashboard, and operator console are separate surfaces", async ({
  page,
}) => {
  await page.goto("/#home");
  await expect(
    page.getByRole("heading", {
      name: "One connection for every tool your agent needs",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".landing-table")).toBeVisible({
    timeout: 10000,
  });
  const dashboardLink = page
    .getByRole("link", { name: "Open dashboard" })
    .first();
  await expect(dashboardLink).toBeInViewport({ ratio: 1 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto("/#dashboard");
  await expect(
    page.getByRole("heading", { name: "My dashboard", exact: true }),
  ).toBeVisible();
  if (test.info().project.name === "mobile")
    await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "User navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Model evaluations" }),
  ).toHaveCount(0);
  if (test.info().project.name === "mobile")
    await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto("/#sessions");
  await expect(
    page.getByRole("heading", { name: "Sessions", exact: true }),
  ).toBeVisible();
  if (test.info().project.name === "mobile")
    await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Operator navigation" }),
  ).toBeVisible();
});

test("dashboard switching lives in settings", async ({ page }) => {
  await page.goto("/#settings");
  await expect(
    page.getByRole("heading", { name: "Connections & settings", exact: true }),
  ).toBeVisible();
  const panel = page.getByRole("navigation", {
    name: "Product views",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await page
    .getByRole("link", { name: /My dashboard/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "My dashboard", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("routing tool toggles persist on the server", async ({ page }) => {
  await page.goto("/#dashboard");
  await page.goto("/#dashboard/routing");
  const toggle = page.getByRole("switch", { name: /exa_search/ });
  await expect(toggle).toBeVisible({ timeout: 10000 });
  const before = await toggle.getAttribute("aria-checked");
  await toggle.click();
  await expect(toggle).toHaveAttribute(
    "aria-checked",
    before === "true" ? "false" : "true",
  );
  await page.reload();
  await expect(
    page.getByRole("switch", { name: /exa_search/ }),
  ).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  await page.getByRole("switch", { name: /exa_search/ }).click();
  await expect(
    page.getByRole("switch", { name: /exa_search/ }),
  ).toHaveAttribute("aria-checked", before!);
});
