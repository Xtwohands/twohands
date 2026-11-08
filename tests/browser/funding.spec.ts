import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("test funding remains disabled by default with clear setup instructions", async ({
  page,
}) => {
  await page.goto("/#dashboard/credits");
  await expect(
    page.getByRole("heading", { name: "Credits", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading deposit history…")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add test credits", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".ws-funding-method")).toContainText(
    "Setup required",
  );
  await expect(page.locator(".ws-funding-notice")).toContainText(
    "Mainnet deposits are not supported",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("fixture test deposit creates, verifies, and credits exactly once", async ({
  page,
  request,
}) => {
  const base = "http://127.0.0.1:3102";
  // Fresh requests may be created in both projects; the shared fixture chain transaction can credit only once.
  const uniqueHash = `0x${"33".repeat(32)}`;
  await page.goto(`${base}/#dashboard/credits`);
  await page
    .getByRole("button", { name: "Add test credits", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Sending wallet address" })
    .fill(`0x${"11".repeat(20)}`);
  await page
    .getByRole("button", { name: "Create deposit request", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Awaiting transfer");
  await page
    .getByRole("textbox", { name: "Deposit transaction hash", exact: true })
    .fill(uniqueHash);
  const before = await (
    await request.get(`${base}/api/workspace/funding`)
  ).json();
  await page
    .getByRole("button", { name: "Verify transaction", exact: true })
    .click();
  if (before.totalDeposits === 0) {
    await expect(page.getByRole("dialog")).toContainText(
      "10.00 test USDC added",
    );
  } else {
    await expect(page.getByRole("dialog")).toContainText(
      "already been credited",
    );
  }
  const after = await (
    await request.get(`${base}/api/workspace/funding`)
  ).json();
  expect(after.balanceUnits).toBe(10000000);
  expect(after.totalDeposits).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".ws-balance-card")).toContainText("10.00");
  await page.reload();
  await expect(page.locator(".ws-balance-card")).toContainText("10.00");
});
