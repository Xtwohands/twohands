import { it, expect } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../server/store";
import { Observatory, sessionInput } from "../server/observation";
const execute = promisify(execFile);
const input = () =>
  sessionInput.parse({
    title: "Durability fixture",
    objective: "Preserve the accepted intent and outcomes.",
    criteria: [{ text: "Evidence is preserved", weight: 1 }],
    budgetMicros: 1000,
  });
it("survives an actual process kill after reservation and never repeats uncertain provider work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apilayer-crash-"));
  const path = join(dir, "workspace.sqlite");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("tests/fixtures/observation-crash.ts")],
    {
      env: { ...process.env, CRASH_TEST_DB: path },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let store: Store | undefined;
  try {
    const sessionId = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("Crash fixture did not reserve a call")),
        5000,
      );
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const line = buffer.split("\n")[0];
        try {
          const data = JSON.parse(line);
          if (data.ready) {
            clearTimeout(timer);
            resolve(data.sessionId);
          }
        } catch {}
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    store = new Store(path);
    let executed = 0;
    const obs = new Observatory(store, {
      search: async () => {
        executed++;
        return { httpStatus: 200, sources: [] };
      },
      scrape: async () => {
        executed++;
        return { httpStatus: 200, text: "Unexpected retry" };
      },
    });
    expect(obs.require(sessionId).reservedMicros).toBe(1000);
    obs.db.recover();
    obs.db.recover();
    const receipt = await obs.execute(sessionId, {
      tool: "firecrawl_extract",
      url: "https://example.com",
      requestKey: "crash-once",
      domains: [],
      statedReason: "Synthetic crash fixture",
    });
    expect(receipt.status).toBe("interrupted");
    expect(executed).toBe(0);
    expect(obs.require(sessionId)).toMatchObject({
      spentMicros: 1000,
      reservedMicros: 0,
    });
    expect(
      obs.db.events(sessionId).filter((e) => e.type === "call_interrupted"),
    ).toHaveLength(1);
    expect(obs.db.detail(sessionId)?.integrity).toBe(true);
  } finally {
    child.kill("SIGKILL");
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("includes records beyond 500 sessions in history and summary", () => {
  const store = new Store(":memory:");
  try {
    const obs = new Observatory(store);
    let first = "";
    for (let i = 0; i < 505; i++) {
      const s = obs.create(input(), "operator_entered");
      first ||= s.id;
    }
    expect(obs.db.list()).toHaveLength(505);
    expect(obs.summary().sessions).toBe(505);
    expect(obs.db.list().some((s) => s.id === first)).toBe(true);
  } finally {
    store.close();
  }
});
it("does not invent a model score for five reviewed sessions with unknown identity", () => {
  const store = new Store(":memory:");
  try {
    const obs = new Observatory(store);
    for (let i = 0; i < 5; i++) {
      const s = obs.create(input(), "operator_entered");
      obs.approve(s.id, s.intentHash);
      const out = obs.outcome(s.id, {
        requestKey: "o",
        text: "Synthetic output",
        evidenceCallIds: [],
      });
      obs.evaluate(s.id, {
        outcomeId: out.outcomes[0].id,
        criteria: s.criteria.map((c) => ({
          criterionId: c.id,
          verdict: "pass",
          note: "Synthetic operator review",
          evidenceCallIds: [],
        })),
      });
    }
    expect(obs.summary().models[0]).toMatchObject({
      fullyReviewed: 5,
      score: null,
    });
  } finally {
    store.close();
  }
});
it("retention deletes old evidence but retains open cases and recent sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apilayer-retention-"));
  const path = join(dir, "workspace.sqlite");
  let store = new Store(path);
  const obs = new Observatory(store);
  const old = obs.create(input(), "operator_entered");
  const held = obs.create(input(), "operator_entered");
  const recent = obs.create(input(), "operator_entered");
  obs.approve(held.id, held.intentHash);
  const out = obs.outcome(held.id, {
    requestKey: "o",
    text: "Synthetic shortfall",
    evidenceCallIds: [],
  });
  const review = obs.evaluate(held.id, {
    outcomeId: out.outcomes[0].id,
    criteria: held.criteria.map((c) => ({
      criterionId: c.id,
      verdict: "fail",
      note: "Synthetic case pending review",
      evidenceCallIds: [],
    })),
  });
  obs.openCase(
    held.id,
    review.evaluations[0].id,
    "Retain the evidence while this review is open.",
  );
  for (const id of [old.id, held.id])
    store.db
      .prepare(
        "UPDATE observation_sessions SET body=json_set(body,'$.updatedAt',?) WHERE id=?",
      )
      .run("2000-01-01T00:00:00Z", id);
  store.close();
  try {
    const result = await execute(
      process.execPath,
      ["--import", "tsx", resolve("server/retention.ts")],
      { env: { ...process.env, DB_PATH: path, RETENTION_DAYS: "30" } },
    );
    expect(result.stdout).toContain("1 observation sessions");
    store = new Store(path);
    const reloaded = new Observatory(store);
    expect(reloaded.db.get(old.id)).toBeUndefined();
    expect(reloaded.db.events(old.id)).toHaveLength(0);
    expect(reloaded.db.get(held.id)).toBeDefined();
    expect(reloaded.db.get(recent.id)).toBeDefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
