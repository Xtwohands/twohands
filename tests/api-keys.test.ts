import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store";
import { Observatory } from "../server/observation";
import { createApp } from "../server/app";
import { config } from "../server/config";
import { ApiKeyService, requiredApiKeyScope } from "../server/api-keys";
import { API_KEY_SCOPES, API_KEY_TOOLS } from "../server/api-key-types";
let store: Store,
  obs: Observatory,
  app: ReturnType<typeof createApp>,
  keys: ApiKeyService;
const original = {
  token: config.token,
  keys: { ...config.keys },
  prices: { ...config.prices },
  rpm: config.rpm,
};
const search = vi.fn(async () => ({ sources: [], httpStatus: 200 }));
const scrape = vi.fn(async () => ({
  text: "fixture evidence",
  httpStatus: 200,
}));
const settings = (extra = {}) => ({
  name: "Codex fixture",
  requestKey: randomUUID(),
  scopes: [...API_KEY_SCOPES],
  allowedTools: [...API_KEY_TOOLS],
  limitUsd: "0.02",
  expiresInDays: 30,
  ...extra,
});
const intent = {
  title: "Key fixture",
  objective: "Find verified fixture evidence",
  criteria: [{ text: "Sources", weight: 1 }],
  constraints: "",
  model: "fixture-model",
  host: "fixture-host",
};
const call = (requestKey = "first", tool = "exa_search") => ({
  tool,
  query: "fixture",
  requestKey,
  statedReason: "Find fixture evidence",
});
const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });
beforeEach(() => {
  store = new Store(":memory:");
  config.token = "owner-fixture-token-0000000000001";
  Object.assign(config.keys, {
    exa: "fixture",
    tavily: "fixture",
    firecrawl: "fixture",
  });
  Object.assign(config.prices, { exa: 7000, tavily: 8000, firecrawl: 1000 });
  config.rpm = 1000;
  search.mockReset().mockResolvedValue({ sources: [], httpStatus: 200 });
  scrape.mockClear();
  obs = new Observatory(store, { search, scrape });
  keys = obs.db.apiKeys;
  app = createApp(store, undefined, obs);
});
afterEach(() => {
  store.close();
  config.token = original.token;
  Object.assign(config.keys, original.keys);
  Object.assign(config.prices, original.prices);
  config.rpm = original.rpm;
});
const create = () => obs.createAgentSession(intent);
describe("scoped workspace API keys", () => {
  it("shows secrets once, persists only hashes, and replays creation without recovering the secret", () => {
    const body = settings(),
      result = keys.create(body);
    expect(result.secret).toMatch(/^oct_key_[A-Za-z0-9_-]{43}$/);
    const row = store.db.prepare("SELECT * FROM workspace_api_keys").get()!;
    expect(row.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(result.secret!);
    expect(JSON.stringify(keys.events(result.key.id))).not.toContain(
      result.secret!,
    );
    expect(keys.create(body)).toMatchObject({
      secret: null,
      replayed: true,
      key: { id: result.key.id },
    });
    expect(keys.list()).toHaveLength(1);
    expect(keys.events(result.key.id)).toHaveLength(1);
    expect(() => keys.create({ ...body, name: "different" })).toThrow(
      /different/,
    );
    expect(new ApiKeyService(store).authenticate(result.secret!).id).toBe(
      result.key.id,
    );
  });
  it("requires owner access for issuance and never treats an invalid scoped key as local owner", async () => {
    expect(
      (await request(app).post("/api/workspace/api-keys").send(settings()))
        .status,
    ).toBe(401);
    const issued = await request(app)
      .post("/api/workspace/api-keys")
      .set(auth(config.token))
      .send(settings());
    expect(issued.status).toBe(201);
    const secret = issued.body.secret;
    expect(
      (await request(app).get("/api/workspace/api-keys").set(auth(secret)))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/workspace/api-keys")
          .set(auth(secret))
          .send(settings())
      ).status,
    ).toBe(403);
    config.token = "";
    expect(
      (await request(app).get("/api/workspace/api-keys").set(auth(secret)))
        .status,
    ).toBe(503);
    expect((await request(app).get("/api/observations")).status).toBe(503);
    const emptyStore = new Store(":memory:");
    try {
      const local = createApp(emptyStore);
      expect(
        (
          await request(local)
            .get("/api/workspace/api-keys")
            .set(auth("oct_key_" + "a".repeat(43)))
        ).status,
      ).toBe(401);
      const disabled = await request(local)
        .get("/api/workspace/api-keys")
        .set("Host", "localhost");
      expect(disabled.status).toBe(200);
      expect(disabled.body.enabled).toBe(false);
      expect(
        (
          await request(local)
            .post("/api/workspace/api-keys")
            .set("Host", "localhost")
            .send(settings())
        ).status,
      ).toBe(503);
    } finally {
      emptyStore.close();
    }
  });
  it("denies owner, funding, legacy and operator routes even to a key with every scope", async () => {
    const { secret } = keys.create(settings());
    for (const [method, path] of [
      ["get", "/api/provider-lab"],
      ["get", "/api/workspace/funding"],
      ["get", "/api/workspace/routing"],
      ["post", "/api/tasks"],
      ["post", "/api/workspace/routing"],
      ["post", "/api/observations"],
      ["post", "/api/observations/proposals"],
      [
        "post",
        "/api/observations/00000000-0000-4000-8000-000000000000/approve",
      ],
      [
        "post",
        "/api/workspace/api-keys/00000000-0000-4000-8000-000000000000/revoke",
      ],
    ]) {
      const operation =
        method === "get"
          ? request(app).get(path)
          : request(app).post(path).send({});
      expect((await operation.set(auth(secret!))).status).toBe(403);
    }
    expect([401, 503]).toContain(
      (await request(app).get("/api/admin/funding/disputes").set(auth(secret!)))
        .status,
    );
    expect(search).not.toHaveBeenCalled();
  });
  it("authorizes exact scopes and refuses alternate methods and unknown paths by default", async () => {
    const { secret } = keys.create(settings({ scopes: ["tools:discover"] }));
    expect(
      (await request(app).get("/api/observations/catalog").set(auth(secret!)))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/observations").set(auth(secret!))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/observations/agent-sessions")
          .set(auth(secret!))
          .send(intent)
      ).status,
    ).toBe(403);
    expect(
      requiredApiKeyScope("DELETE", "/api/observations/catalog"),
    ).toBeNull();
    expect(
      requiredApiKeyScope("POST", "/api/observations/summary/call"),
    ).toBeNull();
    expect(requiredApiKeyScope("GET", "/api/workspace/api-keys")).toBeNull();
    expect(
      (
        await request(app)
          .post("/api/workspace/preview")
          .set(auth(secret!))
          .set("Origin", "https://evil.example")
          .send({ need: "fixture" })
      ).status,
    ).toBe(403);
  });
  it("restricts discovery/preview and execution to the key's allowed tools", async () => {
    const { key, secret } = keys.create(
      settings({ allowedTools: ["tavily_search"] }),
    );
    const session = create();
    const result = await request(app)
      .post(`/api/observations/${session.id}/discover`)
      .set(auth(secret!))
      .send({
        need: "fixture",
        operations: [{ operation: "search", query: "fixture" }],
      });
    expect(result.status).toBe(200);
    expect(result.body.candidateTools).toEqual(["tavily_search"]);
    const preview = await request(app)
      .post("/api/workspace/preview")
      .set(auth(secret!))
      .send({
        need: "fixture",
        operations: [{ operation: "search", query: "fixture" }],
      });
    expect(preview.body.candidateTools).toEqual(["tavily_search"]);
    const denied = await request(app)
      .post(`/api/observations/${session.id}/call`)
      .set(auth(secret!))
      .send(call());
    expect(denied.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
    expect(keys.get(key.id).spentMicros).toBe(0);
  });
  it("attributes tool calls to the authenticated key and charges an idempotent call only once", async () => {
    const { key, secret } = keys.create(settings());
    const created = await request(app)
      .post("/api/observations/agent-sessions")
      .set(auth(secret!))
      .send(intent);
    expect(created.status).toBe(201);
    expect(created.body.apiKeyId).toBe(key.id);
    const first = await request(app)
      .post(`/api/observations/${created.body.id}/call`)
      .set(auth(secret!))
      .send(call());
    expect(first.status).toBe(200);
    expect(first.body.apiKeyId).toBe(key.id);
    const replay = await request(app)
      .post(`/api/observations/${created.body.id}/call`)
      .set(auth(secret!))
      .send(call());
    expect(replay.body.replayed).toBe(true);
    expect(keys.get(key.id)).toMatchObject({
      spentMicros: 7000,
      reservedMicros: 0,
      remainingMicros: 13000,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(app)
          .post(`/api/observations/${created.body.id}/call`)
          .set(auth(secret!))
          .send({ ...call(), apiKeyId: randomUUID() })
      ).status,
    ).toBe(400);
    expect(JSON.stringify(obs.db.detail(created.body.id))).not.toContain(
      secret!,
    );
  });
  it("cannot reset a key's cap by creating another research session", async () => {
    const { key } = keys.create(settings({ limitUsd: "0.01" }));
    const a = create(),
      b = create();
    await obs.execute(a.id, call(), key.id);
    await expect(obs.execute(b.id, call(), key.id)).rejects.toThrow(
      /API key's total/,
    );
    expect(search).toHaveBeenCalledTimes(1);
    expect(obs.db.calls(b.id)).toHaveLength(0);
    expect(obs.require(b.id).reservedMicros).toBe(0);
  });
  it("reserves before network work and prevents concurrent calls from overspending", async () => {
    const { key } = keys.create(settings({ limitUsd: "0.01" }));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    search.mockImplementationOnce(async () => {
      await gate;
      return { sources: [], httpStatus: 200 };
    });
    const a = create(),
      b = create();
    const pending = obs.execute(a.id, call(), key.id);
    expect(keys.get(key.id)).toMatchObject({
      spentMicros: 0,
      reservedMicros: 7000,
    });
    await expect(obs.execute(b.id, call(), key.id)).rejects.toThrow(
      /API key's total/,
    );
    expect(search).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(keys.get(key.id)).toMatchObject({
      spentMicros: 7000,
      reservedMicros: 0,
    });
  });
  it("revokes new access immediately while settling previously admitted calls", async () => {
    const { key, secret } = keys.create(settings());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    search.mockImplementationOnce(async () => {
      await gate;
      return { sources: [], httpStatus: 200 };
    });
    const s = create();
    const pending = obs.execute(s.id, call(), key.id);
    keys.revoke(key.id, { revision: 0 });
    expect(() => keys.authenticate(secret!)).toThrow(/revoked/);
    await expect(obs.execute(s.id, call("second"), key.id)).rejects.toThrow(
      /revoked/,
    );
    release();
    await pending;
    expect(keys.get(key.id)).toMatchObject({
      status: "revoked",
      spentMicros: 7000,
      reservedMicros: 0,
    });
    expect(keys.revoke(key.id, { revision: 0 }).revokedAt).toBeTruthy();
    expect(
      keys.events(key.id).filter((e) => e.type === "revoked"),
    ).toHaveLength(1);
  });
  it("checks expiry at both authentication and provider admission", async () => {
    let now = Date.now();
    const service = new ApiKeyService(store, () => now);
    const issued = service.create(settings({ expiresInDays: 7 }));
    expect(service.authenticate(issued.secret!).id).toBe(issued.key.id);
    now += 7 * 86400000;
    expect(service.get(issued.key.id).status).toBe("expired");
    expect(() => service.authenticate(issued.secret!)).toThrow(/expired/);
    expect(() => service.toolAccess(issued.key.id, "exa_search")).toThrow(
      /expired/,
    );
    let rejected: unknown;
    try {
      service.update(issued.key.id, {
        name: issued.key.name,
        scopes: issued.key.scopes,
        allowedTools: issued.key.allowedTools,
        limitUsd: "0.02",
        revision: 0,
      });
    } catch (e) {
      rejected = e;
    }
    expect(rejected).toMatchObject({ status: 409 });
  });
  it("rejects stale edits and limits below existing spend/reservations", async () => {
    const { key } = keys.create(settings());
    await obs.execute(create().id, call(), key.id);
    const update = {
      name: key.name,
      scopes: key.scopes,
      allowedTools: key.allowedTools,
      limitUsd: "0.005",
      revision: 0,
    };
    expect(() => keys.update(key.id, update)).toThrow(/lower/);
    const next = keys.update(key.id, {
      ...update,
      limitUsd: "0.03",
      scopes: ["tools:discover"],
    });
    expect(next.revision).toBe(1);
    expect(() => keys.update(key.id, { ...update, limitUsd: "0.03" })).toThrow(
      /changed/,
    );
    expect(() => keys.revoke(key.id, { revision: 0 })).toThrow(/changed/);
    await expect(obs.execute(create().id, call(), key.id)).rejects.toThrow(
      /cannot execute/,
    );
    expect(keys.events(key.id).map((e) => e.type)).toEqual([
      "updated",
      "created",
    ]);
  });
  it("retains conservative estimates on provider failure without double charging retries", async () => {
    const { key } = keys.create(settings());
    search.mockRejectedValueOnce(new Error("Unknown provider outcome"));
    const s = create();
    expect((await obs.execute(s.id, call(), key.id)).status).toBe("failed");
    await obs.execute(s.id, call(), key.id);
    expect(keys.get(key.id)).toMatchObject({
      spentMicros: 7000,
      reservedMicros: 0,
    });
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("rolls back key reservation when the enclosing call transaction fails", async () => {
    const { key } = keys.create(settings());
    store.db.exec(
      "CREATE TRIGGER reject_key_call BEFORE INSERT ON observation_calls BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
    );
    await expect(obs.execute(create().id, call(), key.id)).rejects.toThrow();
    expect(keys.get(key.id)).toMatchObject({
      spentMicros: 0,
      reservedMicros: 0,
    });
    expect(search).not.toHaveBeenCalled();
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM api_key_spend").get()!.n,
    ).toBe(0);
  });
  it("keeps key spend charged after research retention and permits free operations at a zero cap", async () => {
    const { key, secret } = keys.create(settings({ limitUsd: "0" }));
    expect(keys.authenticate(secret!).status).toBe("at_limit");
    expect(
      (await request(app).get("/api/observations/catalog").set(auth(secret!)))
        .status,
    ).toBe(200);
    const preview = obs.preview(
      {
        need: "fixture",
        operations: [{ operation: "search", query: "fixture" }],
      },
      key.id,
    );
    expect(preview.budgetMicros).toBe(0);
    expect(preview.candidateTools).toEqual([]);
    await expect(obs.execute(create().id, call(), key.id)).rejects.toThrow(
      /API key's total/,
    );
    const paid = keys.create(settings());
    const s = create();
    await obs.execute(s.id, call(), paid.key.id);
    obs.db.remove(s.id);
    expect(keys.get(paid.key.id).spentMicros).toBe(7000);
  });
  it("parses exact decimal limits and rejects extra privilege/counter fields", () => {
    expect(
      keys.create(settings({ limitUsd: "0.000001" })).key.limitMicros,
    ).toBe(1);
    for (const extra of [
      { limitUsd: "1e3" },
      { limitUsd: "0.0000001" },
      { limitUsd: "1000.000001" },
      { limitUsd: "-1" },
      { scopes: ["admin"] },
      { allowedTools: ["unknown"] },
      { spentMicros: -1 },
      { workspaceId: randomUUID() },
    ])
      expect(() => keys.create(settings(extra))).toThrow();
  });
});
