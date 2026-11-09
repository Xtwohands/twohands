import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.use({ baseURL: "http://127.0.0.1:3102" });
const authOrigin = "https://octolab-fixture.supabase.co";
const userId = "00000000-0000-4000-8000-000000000011";
const first = "00000000-0000-4000-8000-000000000021",
  second = "00000000-0000-4000-8000-000000000022";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = () =>
  encode({ alg: "HS256", typ: "JWT" }) +
  "." +
  encode({
    sub: userId,
    session_id: "00000000-0000-4000-8000-000000000031",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }) +
  ".fixture-signature";
const user = () => ({
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "account@fixture.invalid",
  email_confirmed_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  app_metadata: { provider: "email" },
  user_metadata: {},
});
async function mockAuth(page: Page, empty = false) {
  const state = {
    workspaces: empty
      ? []
      : [
          { id: first, name: "Workspace A", role: "owner" },
          { id: second, name: "Workspace B", role: "owner" },
        ],
    revoked: false,
    pause: false,
    waiting: 0,
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  await page.route(/^http:\/\/127\.0\.0\.1:3102\/(?:\?.*)?$/, async (route) => {
    const response = await route.fetch(),
      headers = response.headers();
    headers["content-security-policy"] = headers[
      "content-security-policy"
    ].replace("connect-src 'self'", "connect-src 'self' " + authOrigin);
    await route.fulfill({ response, headers });
  });
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        url: authOrigin,
        publishableKey: "sb_publishable_fixture",
      },
    }),
  );
  await page.route(authOrigin + "/auth/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    };
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (url.pathname.endsWith("/logout")) {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (url.pathname.endsWith("/recover")) {
      await route.fulfill({ json: {}, headers });
      return;
    }
    if (url.pathname.endsWith("/signup")) {
      await route.fulfill({ json: { user: user(), session: null }, headers });
      return;
    }
    if (url.pathname.endsWith("/token")) {
      const body = req.postDataJSON();
      if (body.password === "incorrect") {
        await route.fulfill({
          status: 400,
          json: {
            code: "invalid_credentials",
            msg: "Invalid login credentials",
          },
          headers,
        });
        return;
      }
      await route.fulfill({
        json: {
          access_token: jwt(),
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: "fixture-refresh-token",
          user: user(),
        },
        headers,
      });
      return;
    }
    await route.fulfill({ json: user(), headers });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: state.revoked ? 401 : 200,
      json: state.revoked
        ? { error: "This session ended." }
        : {
            user: { id: userId, email: "account@fixture.invalid" },
            workspaces: state.workspaces,
            isAdmin: false,
          },
    }),
  );
  await page.route("**/api/auth/workspaces", async (route) => {
    const body = route.request().postDataJSON(),
      workspace = { id: first, name: body.name, role: "owner" };
    state.workspaces = [workspace];
    await route.fulfill({ status: 201, json: workspace });
  });
  await page.route("**/api/workspace/activity?**", async (route) => {
    if (state.revoked) {
      await route.fulfill({
        status: 401,
        json: { error: "This session ended." },
      });
      return;
    }
    const workspace = route.request().headers()["x-octolab-workspace"],
      marker = workspace === second ? "Private B receipt" : "Private A receipt";
    if (state.pause && workspace === first) {
      state.waiting++;
      await gate;
    }
    await route.fulfill({
      json: {
        items: [
          {
            id: "00000000-0000-4000-8000-000000000041",
            sessionId: "00000000-0000-4000-8000-000000000042",
            requestKey: "fixture",
            tool: "exa_search",
            provider: "exa",
            arguments: { query: marker },
            statedReason: "Fixture evidence",
            status: "succeeded",
            startedAt: new Date().toISOString(),
            estimateMicros: 7000,
            sessionTitle: marker,
            host: "fixture",
            model: "fixture",
            reportedUsd: null,
            reportedCredits: null,
            latencyMs: 5,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
  });
  return state;
}
async function login(page: Page) {
  await page.goto("/#dashboard/activity");
  await expect(
    page.getByRole("heading", { name: "Sign in to octolab" }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("account@fixture.invalid");
  await page
    .getByLabel("Password", { exact: true })
    .fill("fixture-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function openNav(page: Page) {
  if (test.info().project.name === "mobile")
    await page.getByRole("button", { name: "Open navigation" }).click();
}
test("email sign-in, persisted session, and sign-out clear the private workspace", async ({
  page,
}) => {
  await mockAuth(page);
  await login(page);
  await expect(page.locator(".ws-activity-table")).toContainText(
    "Private A receipt",
  );
  await page.reload();
  await expect(page.locator(".ws-activity-table")).toContainText(
    "Private A receipt",
  );
  await openNav(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to octolab" }),
  ).toBeVisible();
  await expect(page.getByText("Private A receipt")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("workspace switching discards late responses from the previous workspace", async ({
  page,
}) => {
  const state = await mockAuth(page);
  await login(page);
  await expect(page.locator(".ws-activity-table")).toContainText(
    "Private A receipt",
  );
  state.pause = true;
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect.poll(() => state.waiting).toBeGreaterThan(0);
  await openNav(page);
  await page
    .getByRole("combobox", { name: "Current workspace" })
    .selectOption(second);
  state.release();
  await expect(page.locator(".ws-activity-table")).toContainText(
    "Private B receipt",
  );
  await expect(page.getByText("Private A receipt")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".ws-activity-table")).toContainText(
    "Private B receipt",
  );
});
test("new accounts explicitly create a workspace and expired access removes private content", async ({
  page,
}) => {
  const state = await mockAuth(page, true);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await page.getByLabel("Workspace name").fill("My new workspace");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page.locator(".ws-activity-table")).toContainText(
    "Private A receipt",
  );
  state.revoked = true;
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to octolab" }),
  ).toBeVisible();
  await expect(page.getByText("Private A receipt")).toHaveCount(0);
});
test("confirmation, recovery, invalid credentials, and public landing stay usable", async ({
  page,
}) => {
  await mockAuth(page);
  await page.goto("/#home");
  await expect(
    page.getByRole("heading", { name: "Sign in to octolab" }),
  ).toHaveCount(0);
  await page.goto("/#dashboard");
  await expect(
    page.getByRole("heading", { name: "Sign in to octolab" }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("account@fixture.invalid");
  await page.getByLabel("Password", { exact: true }).fill("incorrect");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Invalid login credentials")).toBeVisible();
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .fill("fixture-password-123");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page
    .getByRole("button", { name: "Forgot password?", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("If the account exists");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
