import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { Store } from "../server/store";
import { analytics } from "../server/analytics";
import { createTask } from "./helpers";
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
function trace(consent = true) {
  const task = createTask(store, { consent });
  const invocationId = task.id + "-invocation";
  const candidates = [
    { provider: "exa", eligible: true, reasons: [] },
    { provider: "tavily", eligible: true, reasons: [] },
  ];
  store.event(task.id, "tool_invoked", {
    invocationId,
    query: "PRIVATE QUERY",
  });
  store.event(task.id, "provider_candidates", { invocationId, candidates });
  store.event(
    task.id,
    "route_selected",
    { invocationId, provider: "tavily" },
    "first-" + task.id,
  );
  store.event(
    task.id,
    "provider_response",
    {
      invocationId,
      provider: "tavily",
      success: true,
      httpStatus: 200,
      latencyMs: 120,
      resultCount: 1,
    },
    "first-" + task.id,
  );
  store.event(
    task.id,
    "outcome_evaluated",
    { invocationId, pass: false },
    "first-" + task.id,
  );
  store.event(task.id, "fallback_triggered", { invocationId });
  store.event(task.id, "provider_candidates", {
    invocationId,
    candidates: [
      { ...candidates[0] },
      {
        ...candidates[1],
        eligible: false,
        reasons: ["Already attempted for this invocation"],
      },
    ],
  });
  store.event(
    task.id,
    "route_selected",
    { invocationId, provider: "exa" },
    "second-" + task.id,
  );
  store.event(
    task.id,
    "provider_response",
    {
      invocationId,
      provider: "exa",
      success: true,
      httpStatus: 200,
      latencyMs: 200,
      resultCount: 3,
    },
    "second-" + task.id,
  );
  store.event(
    task.id,
    "outcome_evaluated",
    { invocationId, pass: true },
    "second-" + task.id,
  );
  return task;
}
describe("privacy-preserving cross-provider aggregates", () => {
  it("counts an initial routing opportunity once, excluding fallback rechecks", () => {
    for (let i = 0; i < 5; i++) trace();
    const data = analytics(store);
    expect(data.suppressed).toBe(false);
    if (data.suppressed) return;
    const exa = data.providers.find((p) => p.provider === "exa")!;
    const tavily = data.providers.find((p) => p.provider === "tavily")!;
    expect(exa).toMatchObject({ eligible: 5, selected: 0, calls: 5 });
    expect(tavily).toMatchObject({ eligible: 5, selected: 5, calls: 5 });
    expect(data.fallbackRecoveries).toBe(5);
    expect(data.insufficient200).toBe(5);
    expect(JSON.stringify(data)).not.toContain("PRIVATE QUERY");
  });
  it("withholds rare metric cohorts even after the overall task threshold is reached", () => {
    trace();
    for (let i = 0; i < 4; i++) createTask(store, { consent: true });
    const data = analytics(store);
    if (data.suppressed) throw new Error("Overall cohort should be ready");
    expect(data.capabilities.search).toBeNull();
    expect(data.fallbacks).toBeNull();
    expect(data.providers.every((p) => p.suppressed)).toBe(true);
  });
  it("excludes nonconsenting traces and never counts their recovered outcomes", () => {
    for (let i = 0; i < 5; i++) trace(false);
    expect(analytics(store)).toMatchObject({ suppressed: true, cohortSize: 0 });
  });
});
