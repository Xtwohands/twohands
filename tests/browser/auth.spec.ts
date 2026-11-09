import { test, expect, type Page } from "@playwright/test";
import { captureJourney } from "./helpers/launch-screenshots";
import AxeBuilder from "@axe-core/playwright";
const authBrowserUrl =
  process.env.OCTOLAB_AUTH_BROWSER_URL || "http://127.0.0.1:3102";
test.use({ baseURL: authBrowserUrl });
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
async function mockAuth(
  page: Page,
  empty = false,
  role: "user" | "company" | "admin" = "user",
) {
  const state = {
    companies: [] as any[],
    role,
    reviewed: null as any,
    members: [
      {
        id: userId,
        email: "account@fixture.invalid",
        role: "owner",
        createdAt: new Date().toISOString(),
      },
    ],
    workspaces:
      empty || role !== "user"
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
  await page.route(
    (url) => url.origin === authBrowserUrl && url.pathname === "/",
    async (route) => {
      const response = await route.fetch(),
        headers = response.headers();
      headers["content-security-policy"] = headers[
        "content-security-policy"
      ].replace("connect-src 'self'", "connect-src 'self' " + authOrigin);
      await route.fulfill({ response, headers });
    },
  );
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
            isAdmin:
              state.role === "admin" &&
              !route.request().headers()["x-octolab-preview"],
            canPreview: state.role === "admin",
            companies: state.companies,
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
  const company = {
    id: "00000000-0000-4000-8000-000000000051",
    name: "Fixture tools",
    website: "https://tools.fixture.invalid",
    toolName: "Fixture search",
    description: "Search integration for fixture evidence.",
    status: "pending",
    role: "owner",
    providerId: null,
    insightsEnabled: false,
    feedback: "",
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route("**/api/auth/companies", async (route) => {
    const body = route.request().postDataJSON();
    const saved = { ...company, ...body };
    state.companies = [saved];
    await route.fulfill({ status: 201, json: saved });
  });
  await page.route("**/api/companies/*", async (route) => {
    const item = state.companies.find((c) =>
      route.request().url().endsWith(c.id),
    );
    await route.fulfill({
      status: item ? 200 : 404,
      json: item ?? { error: "Company not found." },
    });
  });
  await page.route("**/api/companies/*/insights", async (route) => {
    const item = state.companies[0];
    await route.fulfill({
      status: item?.status === "approved" ? 200 : 403,
      json:
        item?.status === "approved"
          ? {
              providerId: item.providerId,
              minimumCohort: 5,
              status: "insufficient_data",
              metrics: null,
            }
          : {
              error:
                "Company approval is required before insights are available.",
            },
    });
  });
  await page.route("**/api/companies/*/resubmit", async (route) => {
    const body = route.request().postDataJSON();
    if (body.revision !== state.companies[0].revision) {
      await route.fulfill({
        status: 409,
        json: { error: "Stale registration." },
      });
      return;
    }
    state.companies[0] = {
      ...state.companies[0],
      ...body,
      status: "pending",
      revision: body.revision + 1,
    };
    await route.fulfill({ json: state.companies[0] });
  });
  await page.route("**/api/companies/*/members", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (body.action === "grant")
        state.members.push({
          id: "00000000-0000-4000-8000-000000000099",
          email: body.email,
          role: "analyst",
          createdAt: new Date().toISOString(),
        });
      else state.members = state.members.filter((m) => m.id !== body.userId);
      await route.fulfill({ json: { replayed: false } });
    } else await route.fulfill({ json: state.members });
  });
  await page.route("**/api/companies/*/access-history", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/admin/companies?**", (route) =>
    route.fulfill({
      status: state.role === "admin" ? 200 : 403,
      json:
        state.role === "admin"
          ? {
              items: [{ ...company, ownerEmail: "owner@fixture.invalid" }],
              nextCursor: null,
            }
          : { error: "Platform administrator access is required." },
    }),
  );
  await page.route("**/api/admin/companies/*/history", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/admin/companies/*/review", async (route) => {
    state.reviewed = route.request().postDataJSON();
    await route.fulfill({
      json: { ...company, ...state.reviewed, revision: 1 },
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
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Current workspace" })
    .selectOption(second);
  state.release();
  await page.goto("/#dashboard/activity");
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
  await captureJourney(page, "new-workspace");
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
  await captureJourney(page, "expired-session");
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

test("tool company registration never forces a customer workspace or exposes the operator lab", async ({
  page,
}) => {
  const state = await mockAuth(page, true, "company");
  await page.goto("/#company");
  await page
    .getByLabel("Email", { exact: true })
    .fill("account@fixture.invalid");
  await page
    .getByLabel("Password", { exact: true })
    .fill("fixture-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Bring your tool to octolab" }),
  ).toBeVisible();
  await expect(page.getByLabel("Workspace name")).toHaveCount(0);
  await page.getByLabel("Company name", { exact: true }).fill("Fixture tools");
  await page
    .getByLabel("Company website")
    .fill("https://tools.fixture.invalid");
  await page.getByLabel("Tool name", { exact: true }).fill("Fixture search");
  await page
    .getByLabel("What does your tool do?")
    .fill("Search integration for fixture evidence.");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(
    page.getByRole("heading", { name: "Fixture tools" }),
  ).toBeVisible();
  await expect(page.getByText("Under review", { exact: true })).toBeVisible();
  await captureJourney(page, "company-pending");
  await openNav(page);
  await expect(
    page.getByRole("link", { name: "Provider lab", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "API keys", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Tool insights", exact: true }).click();
  await expect(
    page.getByText(
      "Insights will become available after your company and integration are approved.",
    ),
  ).toBeVisible();
  await openNav(page);
  await page.getByRole("link", { name: "Company team", exact: true }).click();
  await page
    .getByLabel("Analyst email", { exact: true })
    .fill("teammate@fixture.invalid");
  await page.getByRole("button", { name: "Add analyst", exact: true }).click();
  await expect(
    page.getByText("teammate@fixture.invalid", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove access", exact: true })
    .click();
  await expect(
    page.getByText("teammate@fixture.invalid", { exact: true }),
  ).toHaveCount(0);
  await openNav(page);
  await page.getByRole("link", { name: "Tool insights", exact: true }).click();
  state.companies[0] = {
    ...state.companies[0],
    status: "approved",
    providerId: "exa",
    insightsEnabled: true,
  };
  await page.reload();
  await expect(page.getByText(/No report available yet/)).toBeVisible();
  await captureJourney(page, "company-approved-no-cohort");
  state.companies[0].status = "rejected";
  state.companies[0].revision = 1;
  await page.goto("/#company/" + state.companies[0].id + "/overview");
  await page
    .getByRole("button", { name: "Update registration", exact: true })
    .click();
  await page
    .getByLabel("What does your tool do?")
    .fill("Updated ownership details for the reviewed tool.");
  await page
    .getByRole("button", { name: "Resubmit for review", exact: true })
    .click();
  await expect(page.getByText("Under review", { exact: true })).toBeVisible();
  state.companies[0].status = "suspended";
  await page.goto("/#company/" + state.companies[0].id + "/insights");
  await page.reload();
  await expect(
    page.getByText(
      "Insights will become available after your company and integration are approved.",
    ),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("admin company reviews work without creating a customer workspace", async ({
  page,
}) => {
  const state = await mockAuth(page, true, "admin");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Company reviews" }),
  ).toBeVisible();
  await expect(page.getByLabel("Workspace name")).toHaveCount(0);
  await page.getByRole("button", { name: /Fixture tools/ }).click();
  await page.getByLabel("Verified provider integration").selectOption("exa");
  await page
    .getByLabel("Feedback to company")
    .fill("Ownership checked against the company website.");
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Company review saved");
  await captureJourney(page, "admin-approval");
  expect(state.reviewed).toMatchObject({
    status: "approved",
    providerId: "exa",
    insightsEnabled: false,
    revision: 0,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("account settings replace the sidebar area switcher and preserve user navigation", async ({
  page,
}) => {
  await mockAuth(page);
  await login(page);
  await openNav(page);
  await expect(
    page.getByRole("link", { name: "Administration", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Preview as")).toHaveCount(0);
  await expect(page.getByText("Your areas", { exact: true })).toHaveCount(0);
  await openNav(page);
  await page
    .getByRole("link", { name: "Back to dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(/#dashboard/);
});

test("administrator previews standard roles from settings and can always return", async ({
  page,
}) => {
  await mockAuth(page, true, "admin");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Company reviews" }),
  ).toBeVisible();
  await openNav(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Preview as").selectOption("company");
  await expect(
    page.getByRole("heading", { name: "Bring your tool to octolab" }),
  ).toBeVisible();
  await expect(
    page.getByText("Previewing as tool company", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Your areas", { exact: true })).toHaveCount(0);
  await captureJourney(page, "role-preview-company");
  await page
    .getByRole("button", { name: "Return to admin", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Company reviews" }),
  ).toBeVisible();
  await openNav(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Preview as").selectOption("user");
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Return to admin", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Company reviews" }),
  ).toBeVisible();
});

test("workspace members get usable connection guidance without owner-only key controls", async ({
  page,
}) => {
  const state = await mockAuth(page);
  state.workspaces[0].role = "member";
  await login(page);
  await page.goto("/#dashboard/connections");
  await expect(
    page.getByText(
      "Ask your workspace owner for a scoped API key before starting the bridge.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage API keys", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".ws-agent-environment")).toContainText(
    "APILAYER_URL=" + new URL("/api", authBrowserUrl).href,
  );
  await captureJourney(page, "member-connection-setup");
});

test("signed-in workspace owner can create the first key and proceed to agent setup", async ({
  page,
}) => {
  await mockAuth(page);
  const secret = "oct_key_" + "launch_fixture_secret".padEnd(43, "x");
  let created: any = null;
  let sentHeaders: Record<string, string> = {};
  await page.route("**/api/workspace/api-keys", async (route) => {
    if (route.request().method() === "POST") {
      sentHeaders = route.request().headers();
      const body = route.request().postDataJSON();
      created = {
        id: "00000000-0000-4000-8000-000000000071",
        workspaceId: first,
        name: body.name,
        prefix: secret.slice(0, 15),
        scopes: body.scopes,
        allowedTools: body.allowedTools,
        limitMicros: 10000000,
        spentMicros: 0,
        reservedMicros: 0,
        remainingMicros: 10000000,
        revision: 0,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null,
        lastUsedAt: null,
        status: "active",
      };
      await route.fulfill({ status: 201, json: { key: created, secret } });
    } else
      await route.fulfill({
        json: {
          keys: created ? [created] : [],
          enabled: true,
          unavailableReason: null,
        },
      });
  });
  await login(page);
  await page.goto("/#dashboard/keys");
  await expect(
    page.getByRole("button", { name: "Create API key", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  await page.getByLabel("API key name", { exact: true }).fill("First agent");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expect(
    page.getByLabel("New API key secret", { exact: true }),
  ).toHaveAttribute("type", "password");
  expect(sentHeaders.authorization).toMatch(/^Bearer /);
  expect(sentHeaders["x-octolab-workspace"]).toBe(first);
  await captureJourney(page, "first-api-key");
  await page
    .getByRole("link", { name: "Agent connection setup", exact: true })
    .click();
  await expect(
    page.getByLabel("New API key secret", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".ws-agent-environment")).toContainText(
    "APILAYER_URL=" + new URL("/api", authBrowserUrl).href,
  );
  expect(page.url()).not.toContain(secret);
  await captureJourney(page, "owner-agent-setup");
});
