import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Store } from "../server/store";
import { Observatory, sessionInput } from "../server/observation";
import { config } from "../server/config";
import { ProviderError } from "../server/providers";

let store: Store;
let obs: Observatory;
const keys = { ...config.keys };
const search = vi.fn(async () => ({
  sources: [],
  httpStatus: 200,
  usage: { credits: 1, source: "Fixture" },
}));
const scrape = vi.fn(async () => ({
  text: "Example Domain",
  httpStatus: 200,
  pageStatus: 200,
}));
const input = () =>
  sessionInput.parse({
    title: "Fixture intent",
    objective: "Find evidence supporting the requested output",
    criteria: [
      { text: "Cites evidence", weight: 2 },
      { text: "Explains uncertainty", weight: 1 },
    ],
    budgetMicros: 25000,
    model: "test-model",
    host: "test-host",
  });
const create = (approved = true) => {
  const s = obs.create(input(), "operator_entered");
  return approved ? obs.approve(s.id, s.intentHash) : s;
};
const call = (
  key = "call-1",
  tool: "exa_search" | "tavily_search" = "exa_search",
) => ({
  tool,
  query: "fixture research",
  requestKey: key,
  domains: [],
  statedReason: "Need supporting evidence",
});
beforeEach(() => {
  Object.assign(config.keys, {
    exa: "FIXTURE",
    tavily: "FIXTURE",
    firecrawl: "FIXTURE",
  });
  store = new Store(":memory:");
  search.mockClear();
  scrape.mockClear();
  obs = new Observatory(store, { search, scrape });
});
afterEach(() => {
  store.close();
  Object.assign(config.keys, keys);
});

describe("accepted intent and explicit provider execution", () => {
  it("records a proposal with sharing off and refuses spending before approval", async () => {
    const s = create(false);
    expect(s.commercialConsent).toBe(false);
    expect(s.approvedAt).toBeNull();
    await expect(obs.execute(s.id, call())).rejects.toThrow(/Approve/);
    expect(search).not.toHaveBeenCalled();
    expect(obs.db.calls(s.id)).toHaveLength(0);
  });
  it("requires the exact intent hash and keeps approval idempotent", () => {
    const s = create(false);
    expect(() => obs.approve(s.id, "wrong")).toThrow(/version/);
    obs.approve(s.id, s.intentHash);
    obs.approve(s.id, s.intentHash);
    expect(
      obs.db.events(s.id).filter((e) => e.type === "intent_approved"),
    ).toHaveLength(1);
  });
  it("rejects duplicate criteria instead of inflating the score", () => {
    const i = input();
    i.criteria = [
      { text: "Evidence", weight: 1 },
      { text: "evidence", weight: 2 },
    ];
    expect(() => obs.create(i, "agent_reported")).toThrow(/distinct/);
  });
  it("executes the selected provider without consulting the old router", async () => {
    const s = create();
    const c = await obs.execute(s.id, call());
    expect(search).toHaveBeenCalledWith("exa", "fixture research", [], c.id);
    expect(c.status).toBe("succeeded");
    expect(obs.require(s.id).spentMicros).toBe(17000);
    expect(obs.require(s.id).reservedMicros).toBe(0);
    expect(
      obs.db.events(s.id).find((e) => e.type === "selection_explanation")
        ?.provenance,
    ).toBe("agent_reported");
    expect(
      obs.db.events(s.id).find((e) => e.type === "tool_called")?.provenance,
    ).toBe("observed");
  });
  it("replays the same operation without a second provider call and rejects changed arguments", async () => {
    const s = create();
    const first = await obs.execute(s.id, call());
    const replay = await obs.execute(s.id, call());
    expect(replay.id).toBe(first.id);
    expect(search).toHaveBeenCalledTimes(1);
    await expect(
      obs.execute(s.id, { ...call(), query: "different" }),
    ).rejects.toThrow(/different arguments/);
  });
  it("reserves concurrent budgets before either provider returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    search.mockImplementationOnce(async () => {
      await gate;
      return {
        sources: [],
        httpStatus: 200,
        usage: { credits: 1, source: "Fixture" },
      };
    });
    const s = create();
    const pending = obs.execute(s.id, call());
    expect(obs.require(s.id).reservedMicros).toBe(17000);
    await expect(obs.execute(s.id, call("second"))).rejects.toThrow(/budget/);
    const retry = await obs.execute(s.id, call());
    expect(retry.status).toBe("running");
    expect(search).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(obs.require(s.id).reservedMicros).toBe(0);
  });
  it("allows exactly the accepted budget and rejects the next call", async () => {
    const s = create();
    await obs.execute(s.id, call());
    await obs.execute(s.id, call("second", "tavily_search"));
    expect(obs.require(s.id).spentMicros).toBe(25000);
    await expect(
      obs.execute(s.id, call("third", "tavily_search")),
    ).rejects.toThrow(/budget/);
  });
  it("records failed calls and settles their estimate conservatively", async () => {
    search.mockRejectedValueOnce(new ProviderError("timeout", 200));
    const s = create();
    const c = await obs.execute(s.id, call());
    expect(c).toMatchObject({
      status: "failed",
      httpStatus: 200,
      error: "Provider timeout",
    });
    expect(obs.require(s.id).spentMicros).toBe(17000);
    expect(obs.active.size).toBe(0);
  });
  it("never reflects unexpected exception bodies", async () => {
    search.mockRejectedValueOnce(new Error("SECRET_VENDOR_BODY"));
    const s = create();
    const c = await obs.execute(s.id, call());
    expect(JSON.stringify(c)).not.toContain("SECRET_VENDOR_BODY");
    expect(c.error).toBe("Provider request failed.");
  });
  it("checks configured keys before attempting a call", async () => {
    config.keys.exa = "";
    const s = create();
    await expect(obs.execute(s.id, call())).rejects.toThrow(/not configured/);
    expect(search).not.toHaveBeenCalled();
  });
  it.each([
    "http://example.com",
    "https://127.0.0.1",
    "https://user:password@example.com",
    "https://private.local",
    "https://example.com:8443",
  ])("blocks unsafe extraction URL %s", async (url) => {
    const s = create();
    await expect(
      obs.execute(s.id, {
        tool: "firecrawl_extract",
        url,
        requestKey: "extract",
        domains: [],
        statedReason: "",
      }),
    ).rejects.toThrow(/public HTTPS/);
    expect(scrape).not.toHaveBeenCalled();
  });
  it("preserves a page 404 inside an API 200 response without claiming success of the intent", async () => {
    scrape.mockResolvedValueOnce({
      text: "Not found",
      httpStatus: 200,
      pageStatus: 404,
    });
    const s = create();
    const c = await obs.execute(s.id, {
      tool: "firecrawl_extract",
      url: "https://example.com/missing",
      requestKey: "extract",
      domains: [],
      statedReason: "",
    });
    expect(c.result?.pageStatus).toBe(404);
    expect(obs.require(s.id).evaluations).toEqual([]);
  });
  it("records the offered catalog without fabricated selection or quality scores", () => {
    const s = create();
    const d = obs.discover(s.id, "Search for sources");
    expect(d.tools).toHaveLength(3);
    expect(
      d.tools.every((t) => t.averageLatencyMs === null && t.quality === null),
    ).toBe(true);
    expect(obs.db.calls(s.id)).toHaveLength(0);
  });
});

describe("outcome versions, review coverage, and case evidence", () => {
  function output(id: string, key = "output-1") {
    return obs.outcome(id, {
      requestKey: key,
      text: "A final answer with limitations",
      evidenceCallIds: [],
    });
  }
  function review(
    id: string,
    verdicts: ("pass" | "fail" | "unknown")[] = ["pass", "unknown"],
  ) {
    const s = obs.require(id);
    return obs.evaluate(id, {
      outcomeId: s.outcomes.at(-1)!.id,
      criteria: s.criteria.map((c, i) => ({
        criterionId: c.id,
        verdict: verdicts[i],
        note: "Compared the output with the accepted criterion.",
        evidenceCallIds: [],
      })),
    });
  }
  it("stores actual output as agent-reported, distinct from a review", () => {
    const s = create();
    output(s.id);
    expect(obs.require(s.id).outcomes[0].source).toBe("agent_reported");
    expect(obs.require(s.id).evaluations).toHaveLength(0);
  });
  it("makes output retries idempotent and rejects changed content", () => {
    const s = create();
    output(s.id);
    output(s.id);
    expect(obs.require(s.id).outcomes).toHaveLength(1);
    expect(() =>
      obs.outcome(s.id, {
        requestKey: "output-1",
        text: "Changed",
        evidenceCallIds: [],
      }),
    ).toThrow(/different content/);
  });
  it("rejects evidence from a different or nonexistent session", () => {
    const s = create();
    expect(() =>
      obs.outcome(s.id, {
        requestKey: "out",
        text: "answer",
        evidenceCallIds: [crypto.randomUUID()],
      }),
    ).toThrow(/this session/);
  });
  it("shows partial review coverage separately from the known-criterion score", () => {
    const s = create();
    output(s.id);
    const e = review(s.id).evaluations.at(-1)!;
    expect(e.score).toBe(100);
    expect(e.coverage).toBe(67);
    expect(e.unknownWeight).toBe(1);
    expect(obs.summary().models[0].fullyReviewed).toBe(0);
  });
  it("does not turn an entirely unknown review into a zero accuracy score", () => {
    const s = create();
    output(s.id);
    const e = review(s.id, ["unknown", "unknown"]).evaluations.at(-1)!;
    expect(e.score).toBeNull();
    expect(e.coverage).toBe(0);
  });
  it("rejects duplicated or missing criterion judgments", () => {
    const s = create();
    output(s.id);
    const criteria = [0, 0].map((i) => ({
      criterionId: s.criteria[i].id,
      verdict: "pass" as const,
      note: "Evidence checked",
      evidenceCallIds: [],
    }));
    expect(() =>
      obs.evaluate(s.id, {
        outcomeId: obs.require(s.id).outcomes[0].id,
        criteria,
      }),
    ).toThrow(/exactly once/);
  });
  it("requires reviewing the latest outcome and preserves past evaluations", () => {
    const s = create();
    output(s.id);
    const old = review(s.id).evaluations[0];
    output(s.id, "output-2");
    expect(() =>
      obs.evaluate(s.id, { outcomeId: old.outcomeId, criteria: old.criteria }),
    ).toThrow(/latest output/);
    expect(obs.summary().reviews).toBe(0);
    expect(obs.require(s.id).evaluations).toHaveLength(1);
  });
  it("opens and resolves a review case without implying an issued refund", () => {
    const s = create();
    output(s.id);
    const e = review(s.id, ["fail", "pass"]).evaluations[0];
    const opened = obs.openCase(
      s.id,
      e.id,
      "The output missed a required criterion.",
    );
    const c = opened.cases[0];
    expect(obs.summary().openCases).toBe(1);
    obs.resolveCase(
      s.id,
      c.id,
      "resolved",
      "Documented a replacement output for the customer.",
    );
    expect(obs.summary().openCases).toBe(0);
    expect(obs.db.events(s.id).at(-1)?.data.paymentIssued).toBe(false);
    expect(() =>
      obs.resolveCase(s.id, c.id, "dismissed", "Cannot overwrite resolution"),
    ).toThrow(/already/);
  });
  it("detects an altered audit payload", () => {
    const s = create();
    expect(obs.db.detail(s.id)?.integrity).toBe(true);
    const e = store.db
      .prepare("SELECT id,body FROM observation_events LIMIT 1")
      .get()!;
    const body = JSON.parse(e.body as string);
    body.data.objective = "Tampered";
    store.db
      .prepare("UPDATE observation_events SET body=? WHERE id=?")
      .run(JSON.stringify(body), e.id);
    expect(obs.db.detail(s.id)?.integrity).toBe(false);
  });
  it("recovers uncertain in-flight work without retrying or releasing its estimate", () => {
    const s = create();
    const c = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      requestKey: "interrupted",
      tool: "exa_search" as const,
      provider: "exa" as const,
      arguments: { query: "fixture" },
      statedReason: "",
      status: "running" as const,
      startedAt: new Date().toISOString(),
      estimateMicros: 17000,
    };
    s.reservedMicros = 17000;
    obs.db.save(s);
    obs.db.saveCall(c, "signature");
    obs.db.recover();
    obs.db.recover();
    expect(obs.require(s.id)).toMatchObject({
      reservedMicros: 0,
      spentMicros: 17000,
    });
    expect(obs.db.calls(s.id)[0].status).toBe("interrupted");
    expect(search).not.toHaveBeenCalled();
    expect(obs.db.detail(s.id)?.integrity).toBe(true);
  });
  it("withholds model comparisons until five fully reviewed sessions", () => {
    for (let i = 0; i < 5; i++) {
      const s = create();
      output(s.id);
      review(s.id, ["pass", "fail"]);
      if (i < 4) expect(obs.summary().models[0].score).toBeNull();
    }
    expect(obs.summary().models[0]).toMatchObject({
      fullyReviewed: 5,
      score: 67,
    });
  });
  it("withdraws sharing immediately and never includes raw intent in the aggregate", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const s = create();
      ids.push(s.id);
      obs.consent(s.id, true);
      await obs.execute(s.id, call(`share-${i}`));
    }
    const aggregate = obs.commercialAggregate();
    expect(aggregate.available).toBe(true);
    expect(aggregate.providers).toHaveLength(1);
    expect(JSON.stringify(aggregate)).not.toContain("fixture research");
    obs.consent(ids[0], false);
    expect(obs.commercialAggregate().available).toBe(false);
  });
});

it("shares rate-limit admission with the earlier research engine", async () => {
  const { Engine } = await import("../server/engine");
  const engine = new Engine(store);
  const shared = new Observatory(store, { search, scrape }, engine.timestamps);
  const s = shared.create(input(), "operator_entered");
  shared.approve(s.id, s.intentHash);
  engine.timestamps.set("exa", Array(config.rpm).fill(Date.now()));
  await expect(shared.execute(s.id, call())).rejects.toThrow(
    "Provider request limit",
  );
  expect(shared.require(s.id).reservedMicros).toBe(0);
  expect(shared.db.calls(s.id)).toHaveLength(0);
  engine.timestamps.set("exa", Array(config.rpm - 1).fill(Date.now()));
  await shared.execute(s.id, call());
  expect(engine.limited().has("exa")).toBe(true);
});
it("preserves assistant-review provenance independently of the delivered output", () => {
  const s = create();
  const out = obs.outcome(s.id, {
    requestKey: "o",
    text: "Synthetic output",
    evidenceCallIds: [],
  });
  const reviewed = obs.evaluate(s.id, {
    outcomeId: out.outcomes[0].id,
    reviewer: { kind: "assistant_reported", label: "Synthetic QA assistant" },
    criteria: s.criteria.map((c) => ({
      criterionId: c.id,
      verdict: "pass",
      note: "Synthetic review, not a human assessment",
      evidenceCallIds: [],
    })),
  });
  expect(reviewed.evaluations[0].reviewer).toEqual({
    kind: "assistant_reported",
    label: "Synthetic QA assistant",
  });
  expect(obs.summary().models[0].assistantReviewed).toBe(1);
  expect(obs.db.events(s.id).at(-1)?.data.reviewer).toEqual(
    reviewed.evaluations[0].reviewer,
  );
});

it("permits an explicit retrospective review without replacing the latest output's score", () => {
  const s = create();
  const original = obs.outcome(s.id, {
    requestKey: "first",
    text: "An earlier incomplete output",
    evidenceCallIds: [],
  }).outcomes[0];
  const revised = obs.outcome(s.id, {
    requestKey: "second",
    text: "A revised output",
    evidenceCallIds: [],
  }).outcomes[1];
  const criteria = s.criteria.map((c) => ({
    criterionId: c.id,
    verdict: "fail" as const,
    note: "The earlier output did not fulfill this criterion.",
    evidenceCallIds: [],
  }));
  expect(() =>
    obs.evaluate(s.id, { outcomeId: original.id, criteria }),
  ).toThrow("latest output");
  obs.evaluate(s.id, { outcomeId: original.id, historical: true, criteria });
  expect(obs.summary().reviews).toBe(0);
  expect(obs.summary().models[0].reviewed).toBe(0);
  obs.evaluate(s.id, {
    outcomeId: revised.id,
    criteria: criteria.map((c) => ({ ...c, verdict: "pass" })),
  });
  expect(obs.summary().reviews).toBe(1);
  expect(obs.db.get(s.id)?.evaluations[0].historical).toBe(true);
  expect(() =>
    obs.evaluate(s.id, {
      outcomeId: crypto.randomUUID(),
      historical: true,
      criteria,
    }),
  ).toThrow("Output version not found");
});
it("withholds aggregate availability when consented sessions do not share a provider cohort", async () => {
  for (let i = 0; i < 5; i++) {
    const s = obs.create(input(), "operator_entered");
    obs.approve(s.id, s.intentHash);
    obs.consent(s.id, true);
    await obs.execute(s.id, {
      ...call(`split-${i}`),
      tool: i < 3 ? "exa_search" : "tavily_search",
    });
  }
  expect(obs.commercialAggregate()).toMatchObject({
    available: false,
    consentedSessions: 5,
    providers: [],
  });
  expect(obs.summary().sharing.available).toBe(false);
});
