import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store";
import { PostgresDatabase } from "../server/database";
import { applyMigrations } from "../server/migration";
import {
  Accounts,
  AccountError,
  type VerifiedIdentity,
} from "../server/accounts";
import { createApp } from "../server/app";
import { config } from "../server/config";
import { FundingService } from "../server/funding";
import { StripeFundingService } from "../server/stripe-funding";
import { FixtureStripeGateway, fixtureStripeSettings } from "./fixtures/stripe";
const url = process.env.OCTOLAB_TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
suite("authenticated account and tenant boundaries", () => {
  let store: Store,
    db: PostgresDatabase,
    accounts: Accounts,
    app: ReturnType<typeof createApp>,
    funding: FundingService,
    stripe: StripeFundingService,
    gateway: FixtureStripeGateway;
  const ids = {
    a: randomUUID(),
    b: randomUUID(),
    admin: randomUUID(),
    legacy: randomUUID(),
  };
  const identities = new Map<string, VerifiedIdentity>();
  const verifier = vi.fn(async (token: string) => {
    const value = identities.get(token);
    if (!value) throw new AccountError(401, "Invalid account session.");
    return value;
  });
  const original = { token: config.token, admin: config.adminToken };
  let aWorkspace: string, bWorkspace: string;
  const headers = (token: string, workspace?: string) => ({
    Authorization: "Bearer " + token,
    ...(workspace ? { "X-Octolab-Workspace": workspace } : {}),
  });
  const intent = {
    title: "Private account fixture",
    objective: "Keep each workspace's research isolated",
    criteria: [{ text: "Private receipt", weight: 1 }],
    model: "fixture",
    host: "fixture",
  };
  beforeAll(async () => {
    store = new Store(":unused:", url!, ids.legacy);
    db = store.db as PostgresDatabase;
    await applyMigrations(db);
    await db.pool.query(
      "CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY,deleted_at TIMESTAMPTZ,banned_until TIMESTAMPTZ); CREATE TABLE IF NOT EXISTS auth.sessions(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,not_after TIMESTAMPTZ);",
    );
    for (const name of ["a", "b", "admin"] as const) {
      const identity = {
        userId: ids[name],
        email: name + "@fixture.invalid",
        sessionId: randomUUID(),
        expiresAt: Date.now() + 3600000,
      };
      identities.set("fixture-" + name, identity);
      await db.pool.query("INSERT INTO auth.users(id) VALUES($1)", [
        identity.userId,
      ]);
      await db.pool.query(
        "INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)",
        [identity.sessionId, identity.userId],
      );
    }
    await db.pool.query(
      "INSERT INTO octolab.workspaces(id,name) VALUES($1,'Historical private workspace')",
      [ids.legacy],
    );
    await db.pool.query(
      "INSERT INTO octolab.workspace_memberships VALUES($1,$2,'owner')",
      [ids.legacy, ids.admin],
    );
    accounts = new Accounts(
      store,
      {
        url: "https://octolab-fixture.supabase.co",
        publishableKey: "sb_publishable_fixture",
        adminUserIds: [ids.admin],
      },
      verifier,
    );
    config.token = "legacy-fixture-owner-token-000000000000";
    config.adminToken = "legacy-fixture-admin";
    funding = new FundingService(store, {
      enabled: false,
      recipient: "",
      rpcUrl: "https://fixture.invalid",
    });
    gateway = new FixtureStripeGateway();
    stripe = new StripeFundingService(
      funding,
      { ...fixtureStripeSettings },
      gateway,
    );
    app = createApp(
      store,
      undefined,
      undefined,
      undefined,
      funding,
      stripe,
      accounts,
    );
  });
  afterAll(async () => {
    config.token = original.token;
    config.adminToken = original.admin;
    if (store) await store.close();
  });
  it("requires verified account access and never falls back to local/owner credentials", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
    const publicConfig = await request(app).get("/api/auth/config");
    expect(publicConfig.headers["content-security-policy"]).toContain(
      "https://octolab-fixture.supabase.co",
    );
    expect(publicConfig.body).toEqual({
      enabled: true,
      url: "https://octolab-fixture.supabase.co",
      publishableKey: "sb_publishable_fixture",
    });
    for (const credential of ["", config.token, "unknown-session"]) {
      const response = await request(app)
        .get("/api/observations")
        .set(credential ? headers(credential) : {});
      expect(response.status).toBe(401);
    }
    const profile = await request(app)
      .get("/api/auth/me")
      .set(headers("fixture-a"));
    expect(profile.status).toBe(200);
    expect(profile.body.workspaces).toEqual([]);
    expect(profile.body.isAdmin).toBe(false);
  });
  it("creates explicitly owned workspaces idempotently without claiming historical data", async () => {
    const input = { name: "Workspace A", requestKey: randomUUID() };
    const [a, b] = await Promise.all([
      request(app)
        .post("/api/auth/workspaces")
        .set(headers("fixture-a"))
        .send(input),
      request(app)
        .post("/api/auth/workspaces")
        .set(headers("fixture-a"))
        .send(input),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    aWorkspace = a.body.id;
    expect(aWorkspace).not.toBe(ids.legacy);
    expect(
      (
        await request(app)
          .post("/api/auth/workspaces")
          .set(headers("fixture-a"))
          .send({ ...input, name: "Changed" })
      ).status,
    ).toBe(409);
    const other = await request(app)
      .post("/api/auth/workspaces")
      .set(headers("fixture-b"))
      .send({ name: "Workspace B", requestKey: randomUUID() });
    expect(other.status).toBe(201);
    bWorkspace = other.body.id;
    expect(
      (
        await request(app)
          .post("/api/auth/workspaces")
          .set({ ...headers("fixture-a"), Origin: "https://unrelated.invalid" })
          .send({ name: "Bad origin", requestKey: randomUUID() })
      ).status,
    ).toBe(403);
  });
  it("denies cross-tenant IDs and checks membership/roles from the database on every request", async () => {
    const created = await request(app)
      .post("/api/observations/agent-sessions")
      .set(headers("fixture-a", aWorkspace))
      .send(intent);
    expect(created.status).toBe(201);
    const sessionId = created.body.id;
    expect(
      (
        await request(app)
          .get("/api/observations/" + sessionId)
          .set(headers("fixture-b", bWorkspace))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get("/api/observations")
          .set(headers("fixture-b", aWorkspace))
      ).status,
    ).toBe(403);
    await db.pool.query(
      "INSERT INTO octolab.workspace_memberships VALUES($1,$2,'member')",
      [aWorkspace, ids.b],
    );
    expect(
      (
        await request(app)
          .get("/api/observations/" + sessionId)
          .set(headers("fixture-b", aWorkspace))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/workspace/routing")
          .set(headers("fixture-b", aWorkspace))
          .send({ revision: 0, disabledTools: [] })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/workspace/api-keys")
          .set(headers("fixture-b", aWorkspace))
      ).status,
    ).toBe(403);
    await db.pool.query(
      "DELETE FROM octolab.workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
      [aWorkspace, ids.b],
    );
    expect(
      (
        await request(app)
          .get("/api/observations/" + sessionId)
          .set(headers("fixture-b", aWorkspace))
      ).status,
    ).toBe(403);
  });
  it("normalizes Express case, trailing-slash and encoded-path variants before role checks", async () => {
    for (const path of [
      "/api/Provider-lab",
      "/API/PROVIDER-LAB/",
      "/api/Provider-Lab/runs",
    ]) {
      const result = path.toLowerCase().endsWith("runs")
        ? await request(app)
            .post(path)
            .set(headers("fixture-a", aWorkspace))
            .send({ requestKey: "case-policy", providers: ["exa"] })
        : await request(app).get(path).set(headers("fixture-a", aWorkspace));
      expect(result.status).toBe(403);
    }
    for (const path of [
      "/api/observations/",
      "/api/Observations",
      "/api/Tasks",
      "/api/observations/%30" + aWorkspace.slice(1) + "/evaluate",
    ])
      expect(
        (
          await request(app)
            .post(path)
            .set(headers("fixture-a", aWorkspace))
            .send({})
        ).status,
      ).toBe(403);
    await db.pool.query(
      "INSERT INTO octolab.workspace_memberships VALUES($1,$2,'member')",
      [aWorkspace, ids.b],
    );
    for (const path of ["/api/Workspace/API-Keys", "/api/Workspace/Funding/"])
      expect(
        (await request(app).get(path).set(headers("fixture-b", aWorkspace)))
          .status,
      ).toBe(403);
    await db.pool.query(
      "DELETE FROM octolab.workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
      [aWorkspace, ids.b],
    );
  });
  it("issues keys with account attribution and routes scoped MCP access to the key's workspace", async () => {
    const result = await request(app)
      .post("/api/workspace/api-keys")
      .set(headers("fixture-a", aWorkspace))
      .send({
        name: "Account key",
        requestKey: randomUUID(),
        scopes: ["research:read", "tools:discover"],
        limitUsd: "0.01",
      });
    expect(
      (
        await request(app)
          .post("/api/provider-lab/runs")
          .set(headers("fixture-a", aWorkspace))
          .send({ requestKey: "not-an-operator", providers: ["exa"] })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/observations")
          .set(headers("fixture-a", aWorkspace))
          .send({})
      ).status,
    ).toBe(403);
    expect(result.status).toBe(201);
    expect(result.body.key.workspaceId).toBe(aWorkspace);
    const secret = result.body.secret,
      key = result.body.key;
    const events = await request(app)
      .get("/api/workspace/api-keys/" + key.id)
      .set(headers("fixture-a", aWorkspace));
    expect(events.body.events[0]).toMatchObject({
      actor: "authenticated_account",
      actorId: ids.a,
    });
    const scoped = await request(app)
      .get("/api/observations")
      .set(headers(secret, bWorkspace));
    expect(scoped.status).toBe(200);
    expect(scoped.body).toHaveLength(1);
    expect(
      (
        await request(app)
          .post("/api/auth/workspaces")
          .set(headers(secret))
          .send({ name: "No owner", requestKey: randomUUID() })
      ).status,
    ).toBe(401);
    expect(
      (await request(app).get("/api/workspace/funding").set(headers(secret)))
        .status,
    ).toBe(403);
  });
  it("routes signed Stripe webhooks to the payment owner and attributes admin reviews", async () => {
    const payment = await store.scope.run(bWorkspace, () =>
      stripe.create({ requestKey: randomUUID(), amount: "10" }),
    );
    const paid = gateway.pay(payment.checkoutSessionId!);
    let event = gateway.signed("checkout.session.completed", paid);
    const response = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", event.signature)
      .send(event.payload.toString());
    expect(response.status).toBe(200);
    expect(
      await store.scope.run(aWorkspace, () => funding.ledger.balance()),
    ).toBe(0);
    expect(
      await store.scope.run(bWorkspace, () => funding.ledger.balance()),
    ).toBe(10000000);
    const disputed = gateway.pay(payment.checkoutSessionId!, 0, true);
    event = gateway.signed("charge.dispute.created", {
      id: "dp_fixture",
      charge: disputed.payment_intent.latest_charge.id,
      payment_intent: disputed.payment_intent.id,
    });
    expect(
      (
        await request(app)
          .post("/api/webhooks/stripe")
          .set("Content-Type", "application/json")
          .set("stripe-signature", event.signature)
          .send(event.payload.toString())
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/admin/funding/disputes")
          .set(headers("fixture-b", bWorkspace))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/admin/funding/disputes")
          .set(headers(config.adminToken, bWorkspace))
      ).status,
    ).toBe(401);
    const detail = await request(app)
      .get("/api/admin/funding/disputes/" + payment.id)
      .set(headers("fixture-admin", bWorkspace));
    expect(detail.status).toBe(200);
    const review = await request(app)
      .post("/api/admin/funding/disputes/" + payment.id + "/review")
      .set(headers("fixture-admin", bWorkspace))
      .send({
        requestKey: randomUUID(),
        revision: detail.body.item.revision,
        evidenceFingerprint: detail.body.item.evidenceFingerprint,
        status: "reviewed",
        note: "Fixture evidence checked by authenticated admin.",
      });
    expect(review.status).toBe(200);
    expect(review.body.history[0].actor).toBe("account " + ids.admin);
    expect(review.body.item.holdRetained).toBe(true);
  });
  it("rejects revoked or banned sessions even while identity verification is cached", async () => {
    await request(app).get("/api/auth/me").set(headers("fixture-a"));
    await db.pool.query("DELETE FROM auth.sessions WHERE id=$1", [
      identities.get("fixture-a")!.sessionId,
    ]);
    expect(
      (await request(app).get("/api/auth/me").set(headers("fixture-a"))).status,
    ).toBe(401);
    await db.pool.query(
      "UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1",
      [ids.b],
    );
    expect(
      (
        await request(app)
          .get("/api/observations")
          .set(headers("fixture-b", bWorkspace))
      ).status,
    ).toBe(401);
    await db.pool.query(
      "UPDATE auth.users SET banned_until=NULL,deleted_at=now() WHERE id=$1",
      [ids.b],
    );
    expect(
      (await request(app).get("/api/auth/me").set(headers("fixture-b"))).status,
    ).toBe(401);
  });
  it("rejects private keys and untrusted auth endpoints in public settings", () => {
    expect(
      () =>
        new Accounts(
          store,
          {
            url: "https://octolab-fixture.supabase.co",
            publishableKey: "sb_secret_fixture",
            adminUserIds: [],
          },
          verifier,
        ),
    ).toThrow(/publishable/);
    expect(
      () =>
        new Accounts(
          store,
          {
            url: "https://unrelated.invalid",
            publishableKey: "sb_publishable_fixture",
            adminUserIds: [],
          },
          verifier,
        ),
    ).toThrow(/project/);
  });
});
