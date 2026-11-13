import { expect, test } from "@playwright/test";
import { providerIds } from "../../server/provider-catalog";

test("provider cards keep zero usage visible and support filtering and pinning", async ({
  page,
}) => {
  await page.route("**/api/workspace/usage?*", async (route) => {
    const response = await route.fetch();
    const usage = await response.json();
    await route.fulfill({
      response,
      json: {
        ...usage,
        requests: 0,
        providers: usage.providers.map((provider: { provider: string }) => ({
          ...provider,
          requests: 0,
          estimatedMicros: 0,
        })),
      },
    });
  });
  await page.goto("/#dashboard");
  const providers = page.getByRole("list", { name: "Provider usage" });
  await expect(providers.getByRole("listitem")).toHaveCount(providerIds.length);
  const exa = providers
    .getByRole("listitem")
    .filter({ hasText: "Exa" })
    .first();
  await expect(exa.locator("dd")).toHaveText(["0", "$0.000", "0%"]);
  const search = page.getByRole("searchbox", { name: "Search providers" });
  await search.fill("Tavily");
  await expect(providers.getByRole("listitem")).toHaveCount(1);
  const pin = providers.getByRole("button", { name: "Pin Tavily" });
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await search.clear();
  await expect(providers.getByRole("listitem").first()).toContainText("Tavily");
  await search.fill("not a provider");
  await expect(
    page.getByRole("status").filter({ hasText: "No matching providers" }),
  ).toBeVisible();
});
