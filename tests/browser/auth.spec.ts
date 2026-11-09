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
  const previewTargets = () => [
    ...state.companies.map((company) => ({
      target: `company:${company.id}`,
      kind: "company",
      id: company.id,
      name: company.name,
      status: company.status,
      providerId: company.providerId,
    })),
    ...["exa", "tavily", "firecrawl"]
      .filter(
        (id) => !state.companies.some((company) => company.providerId === id),
      )
      .map((id) => ({
        target: `provider:${id}`,
        kind: "provider",
        id,
        name: { exa: "Exa", tavily: "Tavily", firecrawl: "Firecrawl" }[id],
        status: "unregistered",
        providerId: id,
      })),
  ];
  await page.route("**/api/auth/preview-targets", (route) =>
    route.fulfill({ json: previewTargets() }),
  );
  await page.route("**/api/auth/preview-insights", (route) =>
    route.fulfill({
      json: {
        providerId: route
          .request()
          .headers()
          ["x-octolab-preview-target"]?.split(":")[1],
        minimumCohort: 0,
        status: "available",
        metrics: {
          offeredSessions: 0,
          selectedSessions: 0,
          calls: 0,
          successfulCalls: 0,
        },
      },
    }),
  );
  await page.route("**/api/auth/me", (route) => {
    const headers = route.request().headers();
    const target = previewTargets().find(
      (target) => target.target === headers["x-octolab-preview-target"],
    );
    return route.fulfill({
      status: state.revoked ? 401 : 200,
      json: state.revoked
        ? { error: "This session ended." }
        : {
            user: { id: userId, email: "account@fixture.invalid" },
            workspaces: target ? [] : state.workspaces,
            isAdmin: state.role === "admin" && !headers["x-octolab-preview"],
            canPreview: state.role === "admin",
            companyPreview: target,
            companies: target
              ? state.companies
                  .filter((company) => company.id === target.id)
                  .map((company) => ({ ...company, role: "owner" }))
              : state.companies,
          },
    });
  });
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
    name: "Fixture tools dashboard",
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
    const item = state.companies.find((company) =>
      route.request().url().includes(company.id),
    );
    await route.fulfill({
      status: item?.status === "approved" ? 200 : 403,
      json:
        item?.status === "approved"
          ? {
              providerId: item.providerId,
              minimumCohort: 0,
              status: "available",
              metrics: {
                offeredSessions: 0,
                selectedSessions: 0,
                calls: 0,
                successfulCalls: 0,
              },
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
async function login(page: Page, destination = "/#dashboard/activity") {
  await page.goto(destination);
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
    page.getByRole("heading", { name: "Fixture tools dashboard" }),
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
  await page.getByRole("link", { name: "Live usage", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No usage available yet", exact: true }),
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
  await page.getByRole("link", { name: "Live usage", exact: true }).click();
  state.companies[0] = {
    ...state.companies[0],
    status: "approved",
    providerId: "exa",
    insightsEnabled: true,
  };
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "No usage available yet", exact: true }),
  ).toBeVisible();
  await captureJourney(page, "company-approved-no-cohort");
  state.companies[0].status = "rejected";
  state.companies[0].revision = 1;
  await page.goto("/#company/" + state.companies[0].id + "/details");
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
    page.getByRole("heading", { name: "No usage available yet", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("admin company reviews work without creating a customer workspace", async ({
  page,
}) => {
  const state = await mockAuth(page, true, "admin");
  await login(page, "/#admin");
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
  await login(page, "/#admin");
  await expect(
    page.getByRole("heading", { name: "Company reviews" }),
  ).toBeVisible();
  await openNav(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Preview as").selectOption("company");
  await page.getByLabel("Company to preview").selectOption("provider:exa");
  await page.getByRole("button", { name: "Open company preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Exa dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByText("Previewing company", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Provider preview", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No usage available yet", exact: true }),
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

test("admin switches selected companies, drops late reports, and retains return access", async ({
  page,
}) => {
  const state = await mockAuth(page, true, "admin");
  const makeCompany = (id: string, name: string, status = "approved") => ({
    id,
    name,
    website: "https://preview.fixture.invalid",
    toolName: name,
    description: "Isolated company preview fixture.",
    status,
    role: "owner",
    providerId: status === "approved" ? "exa" : null,
    insightsEnabled: true,
    revision: 0,
    feedback: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const a = makeCompany(
    "00000000-0000-4000-8000-000000000061",
    "Preview Alpha",
  );
  const b = makeCompany(
    "00000000-0000-4000-8000-000000000062",
    "Preview Beta",
    "pending",
  );
  state.companies = [a, b];
  let release = () => {},
    waiting = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/companies/${a.id}/insights`, async (route) => {
    expect(route.request().headers()["x-octolab-preview-target"]).toBe(
      `company:${a.id}`,
    );
    waiting = true;
    await gate;
    await route.fulfill({
      json: {
        providerId: "exa",
        minimumCohort: 0,
        status: "available",
        metrics: {
          offeredSessions: 987654,
          selectedSessions: 987654,
          calls: 987654,
          successfulCalls: 987654,
        },
      },
    });
  });
  await login(page);
  await openNav(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Preview as").selectOption("company");
  await page.getByLabel("Company to preview").selectOption(`company:${a.id}`);
  await captureJourney(page, "company-preview-picker");
  await page.getByRole("button", { name: "Open company preview" }).click();
  await expect(
    page.getByRole("banner").filter({ hasText: a.name }),
  ).toBeVisible();
  await expect.poll(() => waiting).toBe(true);
  await page
    .getByLabel("Preview company", { exact: true })
    .selectOption(`company:${b.id}`);
  await expect(
    page.getByRole("banner").filter({ hasText: b.name }),
  ).toBeVisible();
  release();
  await expect(page.getByText("987654", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No usage available yet", exact: true }),
  ).toBeVisible();
  await page.goto(`/#company/${b.id}/overview`);
  await expect(
    page.getByText("Under review", { exact: true }).first(),
  ).toBeVisible();
  await captureJourney(page, "company-preview-pending");
  await expect(
    page.getByRole("link", { name: "Register another company" }),
  ).toHaveCount(0);
  await page.goto(`/#company/${a.id}/insights`);
  await expect(
    page.getByText("This page is outside the company you’re previewing."),
  ).toBeVisible();
  await page
    .getByLabel("Preview company", { exact: true })
    .selectOption("provider:tavily");
  await expect(
    page.getByRole("heading", { name: "Tavily dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No usage available yet", exact: true }),
  ).toBeVisible();
  await captureJourney(page, "company-preview-provider");
  await expect(page.locator("body")).not.toContainText("987654");
  await page
    .getByRole("button", { name: "Return to admin", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Company reviews" }),
  ).toBeVisible();
  await expect(page.getByLabel("Preview company", { exact: true })).toHaveCount(
    0,
  );
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

test("admin navigation persists across company reviews and workspace operations", async ({
  page,
}, testInfo) => {
  const state = await mockAuth(page, false, "admin");
  state.workspaces = [
    { id: first, name: "Admin workspace fixture", role: "platform_admin" },
  ];
  await login(page);
  await page.goto("/#admin");
  await expect(
    page.getByRole("heading", { name: "Company reviews", exact: true }),
  ).toBeVisible();
  await openNav(page);
  const before = await page
    .getByRole("navigation")
    .first()
    .getByRole("link")
    .allTextContents();
  await page
    .getByRole("link", { name: "Workspace operations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sessions", exact: true }),
  ).toBeVisible();
  await openNav(page);
  const after = await page
    .getByRole("navigation")
    .last()
    .getByRole("link")
    .allTextContents();
  console.log(
    JSON.stringify({ route: new URL(page.url()).hash, before, after }),
  );
  await page.screenshot({
    path: testInfo.outputPath("admin-operations-navigation.png"),
    fullPage: true,
  });
  await expect(
    page.getByRole("link", { name: "Company reviews", exact: true }),
  ).toBeVisible();
});

test("admin direct workspace route never silently renders company reviews without a workspace", async ({
  page,
}, testInfo) => {
  await mockAuth(page, true, "admin");
  await login(page);
  await page.goto("/#sessions");
  console.log(
    JSON.stringify({
      route: new URL(page.url()).hash,
      headings: await page.getByRole("heading").allTextContents(),
    }),
  );
  await page.screenshot({
    path: testInfo.outputPath("admin-no-workspace-route.png"),
    fullPage: true,
  });
  await expect(
    page.getByRole("heading", { name: "Select a workspace", exact: true }),
  ).toBeVisible();
  await openNav(page);
  await expect(
    page.getByRole("link", { name: "Company reviews", exact: true }),
  ).toBeVisible();
});

test("admin destinations preserve navigation, active links, refresh, and browser history", async ({
  page,
}) => {
  const state = await mockAuth(page, false, "admin");
  state.workspaces = [
    { id: first, name: "Admin workspace fixture", role: "platform_admin" },
  ];
  await login(page);
  await page.goto("/#admin");
  const destinations = [
    { label: "Workspace operations", hash: "#sessions", heading: "Sessions" },
    {
      label: "Payment disputes",
      hash: "#disputes",
      heading: "Payment disputes",
    },
    { label: "Provider lab", hash: "#lab", heading: "Provider lab" },
    { label: "Company reviews", hash: "#admin", heading: "Company reviews" },
  ];
  for (const destination of destinations) {
    await openNav(page);
    await page
      .getByRole("link", { name: destination.label, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(destination.hash + "$"));
    await expect(
      page.getByRole("heading", { name: destination.heading, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: destination.heading, exact: true }),
    ).toBeVisible();
    await openNav(page);
    const nav = page
      .getByRole("navigation", { name: "Admin navigation" })
      .last();
    for (const item of destinations)
      await expect(
        nav.getByRole("link", { name: item.label, exact: true }),
      ).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveText(
      destination.label,
    );
    if (test.info().project.name === "mobile") {
      if (await page.getByRole("dialog").isVisible())
        await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: "Close navigation" }).click();
    }
  }
  await page.goBack();
  await expect(page).toHaveURL(/#lab$/);
  await expect(
    page.getByRole("heading", { name: "Provider lab", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#admin$/);
  await expect(
    page.getByRole("heading", { name: "Company reviews", exact: true }),
  ).toBeVisible();
});

test("admin without a workspace retains route and navigation without workspace requests", async ({
  page,
}) => {
  await mockAuth(page, true, "admin");
  let workspaceRequests = 0;
  page.on("request", (request) => {
    if (
      /\/api\/(observations|tasks|provider-lab|admin\/funding)/.test(
        new URL(request.url()).pathname,
      )
    )
      workspaceRequests++;
  });
  await login(page);
  for (const hash of [
    "#sessions",
    "#sessions/00000000-0000-4000-8000-000000000099",
    "#disputes",
    "#lab",
  ]) {
    await page.goto("/" + hash);
    await expect(
      page.getByRole("heading", { name: "Select a workspace", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(hash + "$"));
    await openNav(page);
    await expect(
      page.getByRole("link", { name: "Company reviews", exact: true }),
    ).toBeVisible();
  }
  expect(workspaceRequests).toBe(0);
});

test("admin tool access requires an explicit audited save, preserves retry key, and pauses without resetting spend", async ({
  page,
}) => {
  await mockAuth(page, true, "admin");
  const allowance = {
    enforced: true,
    state: "unconfigured",
    limitMicros: 0,
    spentMicros: 0,
    reservedMicros: 0,
    remainingMicros: 0,
    revision: 0,
    basis: "estimated_provider_spend_since_activation",
  };
  let value = { ...allowance };
  const writes: any[] = [];
  await page.route("**/api/admin/workspace-allowances", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            workspaceId: first,
            name: "Beta workspace",
            operatorAllowance: value,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/admin/workspace-allowances/*", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    value = {
      ...value,
      limitMicros: body.limitMicros,
      spentMicros: 7000,
      remainingMicros: body.limitMicros - 7000,
      state: body.paused ? "paused" : "available",
      revision: body.revision + 1,
    };
    if (writes.length === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: "Fixture response interrupted. Retry the unchanged request.",
        },
      });
      return;
    }
    await route.fulfill({
      json: { operatorAllowance: value, replayed: writes.length === 2 },
    });
  });
  await login(page);
  await page.goto("/#tool-access");
  await expect(
    page.getByRole("heading", { name: "Tool access", exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: /Beta workspace/ }).click();
  await page
    .getByLabel("Estimated lifetime limit (USD)", { exact: true })
    .fill("0.014");
  await page.getByLabel("Reason for change").fill("Fixture beta authorization");
  await page
    .getByRole("button", { name: "Save tool access", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture response interrupted",
  );
  await page
    .getByRole("button", { name: "Save tool access", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Saved request confirmed",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]).toMatchObject({
    revision: 0,
    limitMicros: 14000,
    paused: false,
    reason: "Fixture beta authorization",
  });
  await page
    .getByLabel("Estimated lifetime limit (USD)", { exact: true })
    .fill("0");
  await page.getByLabel("Reason for change").fill("Fixture invalid shrink");
  await page
    .getByRole("button", { name: "Save tool access", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "below spent and reserved",
  );
  expect(writes).toHaveLength(2);
  await page
    .getByLabel("Estimated lifetime limit (USD)", { exact: true })
    .fill("0.014");
  await page.getByLabel("Pause new provider calls").check();
  await page.getByLabel("Reason for change").fill("Fixture pause");
  await page
    .getByRole("button", { name: "Save tool access", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Tool access saved");
  expect(writes[2]).toMatchObject({
    revision: 1,
    limitMicros: 14000,
    paused: true,
  });
  await expect(page.locator("dl")).toContainText("$0.007");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("ordinary accounts cannot open admin tool access and see honest workspace access status", async ({
  page,
}) => {
  await mockAuth(page);
  await page.route("**/api/workspace/operator-allowance", (route) =>
    route.fulfill({
      json: {
        enforced: true,
        state: "unconfigured",
        limitMicros: 0,
        spentMicros: 0,
        reservedMicros: 0,
        remainingMicros: 0,
        revision: 0,
        basis: "estimated_provider_spend_since_activation",
      },
    }),
  );
  await login(page);
  await expect(
    page.getByRole("status").filter({
      hasText: "Tool access has not been enabled",
    }),
  ).toBeVisible();
  await page.goto("/#tool-access");
  await expect(
    page.getByRole("heading", { name: "Administrator access required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save tool access" }),
  ).toHaveCount(0);
});
