import { beforeEach, afterEach, it, expect } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createObservationMcp } from "../server/mcp-server";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { Observatory } from "../server/observation";
import { config } from "../server/config";
let store: Store;
let obs: Observatory;
let client: Client;
let server: ReturnType<typeof createObservationMcp>;
let app: ReturnType<typeof createApp>;
const oldKeys = { ...config.keys };
const oldToken = config.token;
const intent = {
  title: "MCP fixture",
  objective: "Return a supported answer from a public page.",
  criteria: [
    { text: "Names the page", weight: 1 },
    { text: "Includes a source", weight: 1 },
  ],
  budgetMicros: 26000,
  model: "Protocol fixture, no model",
  host: "MCP test client",
};
function parse(r: any) {
  return JSON.parse(r.content[0].text);
}
beforeEach(async () => {
  config.token = "";
  Object.assign(config.keys, {
    exa: "TEST_KEY",
    tavily: "TEST_KEY",
    firecrawl: "TEST_KEY",
  });
  store = new Store(":memory:");
  obs = new Observatory(store, {
    search: async () => ({ httpStatus: 200, sources: [] }),
    scrape: async () => ({
      httpStatus: 200,
      pageStatus: 200,
      text: "Fixture example page",
    }),
  });
  app = createApp(store, undefined, obs);
  server = createObservationMcp(async (path, body) => {
    const r =
      body === undefined
        ? await request(app).get(`/api${path}`)
        : await request(app)
            .post(`/api${path}`)
            .send(body as object);
    if (r.status >= 400) throw new Error(r.body.error);
    return r.body;
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "apilayer-test-client", version: "1.0.0" });
  await server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  await client.close();
  await server.close();
  store.close();
  Object.assign(config.keys, oldKeys);
  config.token = oldToken;
});
it("exposes distinct provider tools and no approval, scoring, consent, or refund tool", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      "discover_tools",
      "exa_search",
      "firecrawl_extract",
      "get_session",
      "get_evidence",
      "record_intent",
      "submit_outcome",
      "tavily_search",
    ].sort(),
  );
  expect(
    tools.some((t) => /approve|refund|evaluate|consent/.test(t.name)),
  ).toBe(false);
});
it("carries a real protocol flow from proposed intent to selected tool to output", async () => {
  const s = parse(
    await client.callTool({ name: "record_intent", arguments: intent }),
  );
  expect(s.approvalRequired).toBe(true);
  expect(s.modelSource).toBe("agent_reported");
  const blocked = await client.callTool({
    name: "exa_search",
    arguments: { sessionId: s.id, query: "Fixture", requestKey: "search-1" },
  });
  expect(blocked.isError).toBe(true);
  expect(obs.db.calls(s.id)).toHaveLength(0);
  await request(app)
    .post(`/api/observations/${s.id}/approve`)
    .send({ intentHash: s.intentHash })
    .expect(200);
  const offered = parse(
    await client.callTool({
      name: "discover_tools",
      arguments: { sessionId: s.id, need: "Read a known page" },
    }),
  );
  expect(offered.tools).toHaveLength(3);
  const c = parse(
    await client.callTool({
      name: "firecrawl_extract",
      arguments: {
        sessionId: s.id,
        url: "https://example.com",
        requestKey: "extract-1",
        statedReason: "A known URL only needs extraction.",
      },
    }),
  );
  expect(c).toMatchObject({
    tool: "firecrawl_extract",
    status: "succeeded",
    estimateMicros: 1000,
  });
  await client.callTool({
    name: "submit_outcome",
    arguments: {
      sessionId: s.id,
      requestKey: "final-1",
      text: "The fixture page is named Example Domain.",
      evidenceCallIds: [c.id],
    },
  });
  const read = parse(
    await client.callTool({
      name: "get_session",
      arguments: { sessionId: s.id },
    }),
  );
  expect(read.status).toBe("completed");
  expect(read.outcomes).toHaveLength(1);
  expect(read.evaluations).toHaveLength(0);
  expect(read.calls[0].result).toBeUndefined();
  expect(obs.db.detail(s.id)?.integrity).toBe(true);
});
it("validates tool arguments before bridge execution", async () => {
  const r = await client.callTool({
    name: "get_session",
    arguments: { sessionId: "not-a-uuid" },
  });
  expect(r.isError).toBe(true);
  expect(obs.db.list()).toHaveLength(0);
});
it("does not expose configured provider key values through the catalog or tool errors", async () => {
  const s = parse(
    await client.callTool({ name: "record_intent", arguments: intent }),
  );
  const r = await client.callTool({
    name: "discover_tools",
    arguments: { sessionId: s.id, need: "search" },
  });
  expect(JSON.stringify(r)).not.toContain("TEST_KEY");
});
it("guards the new API routes with bearer auth and origin checks", async () => {
  config.token = "workspace-test-token";
  await request(app).get("/api/observations").expect(401);
  await request(app)
    .get("/api/observations")
    .set("Authorization", "Bearer workspace-test-token")
    .expect(200);
  await request(app)
    .post("/api/observations")
    .set("Authorization", "Bearer workspace-test-token")
    .set("Origin", "https://evil.example")
    .send(intent)
    .expect(403);
});
it("sanitizes summary export and retains private evidence only in the local detail", async () => {
  const s = (
    await request(app)
      .post("/api/observations")
      .send({ ...intent, objective: "PRIVATE_INTENT_MARKER" })
      .expect(201)
  ).body;
  await request(app)
    .post(`/api/observations/${s.id}/approve`)
    .send({ intentHash: s.intentHash })
    .expect(200);
  await request(app)
    .post(`/api/observations/${s.id}/outcome`)
    .send({
      requestKey: "out",
      text: "PRIVATE_OUTPUT_MARKER",
      evidenceCallIds: [],
    })
    .expect(200);
  const exported = await request(app)
    .get(`/api/observations/${s.id}/export`)
    .expect(200);
  expect(JSON.stringify(exported.body)).not.toMatch(
    /PRIVATE_INTENT_MARKER|PRIVATE_OUTPUT_MARKER/,
  );
  expect(exported.body.includesResearchContent).toBe(false);
  expect(obs.db.detail(s.id)?.outcomes[0].text).toBe("PRIVATE_OUTPUT_MARKER");
});
it("rejects oversized payloads without creating a session", async () => {
  await request(app)
    .post("/api/observations")
    .send({ ...intent, objective: "x".repeat(170000) })
    .expect(413);
  expect(obs.db.list()).toHaveLength(0);
});
it("deletion needs the exact ID and removes associated audit and call records", async () => {
  const s = (await request(app).post("/api/observations").send(intent)).body;
  await request(app)
    .post(`/api/observations/${s.id}/delete`)
    .send({ confirmSessionId: "wrong" })
    .expect(400);
  await request(app)
    .post(`/api/observations/${s.id}/delete`)
    .send({ confirmSessionId: s.id })
    .expect(200);
  await request(app).get(`/api/observations/${s.id}`).expect(404);
  expect(obs.db.events(s.id)).toHaveLength(0);
});

it("keeps full output text and evaluation notes out of list polling responses", async () => {
  const s = (await request(app).post("/api/observations").send(intent)).body;
  obs.approve(s.id, s.intentHash);
  const out = obs.outcome(s.id, {
    requestKey: "output",
    text: "PRIVATE_LONG_OUTPUT",
    evidenceCallIds: [],
  });
  obs.evaluate(s.id, {
    outcomeId: out.outcomes[0].id,
    criteria: s.criteria.map((c: any) => ({
      criterionId: c.id,
      verdict: "pass",
      note: "PRIVATE_EVALUATION_NOTE",
      evidenceCallIds: [],
    })),
  });
  const list = await request(app).get("/api/observations").expect(200);
  expect(JSON.stringify(list.body)).not.toMatch(
    /PRIVATE_LONG_OUTPUT|PRIVATE_EVALUATION_NOTE/,
  );
  expect(list.body[0].outcomes[0].id).toBe(out.outcomes[0].id);
  expect(list.body[0].evaluations[0].outcomeId).toBe(out.outcomes[0].id);
  expect(obs.db.detail(s.id)?.outcomes[0].text).toBe("PRIVATE_LONG_OUTPUT");
});
