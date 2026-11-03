import { beforeEach, afterEach, it, expect } from "vitest";
import { Store } from "../server/store";
import {
  Observatory,
  sessionInput,
  agentSessionInput,
} from "../server/observation";
import { verifyPrivateEvidence } from "../server/evidence-verification";
import { config } from "../server/config";
let store: Store, obs: Observatory, id: string;
const keys = { ...config.keys };
beforeEach(async () => {
  config.keys.firecrawl = "synthetic";
  store = new Store(":memory:");
  obs = new Observatory(store, {
    search: async () => ({ httpStatus: 200, sources: [] }),
    scrape: async () => ({
      httpStatus: 200,
      pageStatus: 200,
      text: "Synthetic source evidence",
    }),
  });
  const s = obs.create(
    sessionInput.parse({
      title: "Export verification fixture",
      objective: "Validate preserved evidence and review records.",
      criteria: [{ text: "Source supports output", weight: 1 }],
      budgetMicros: 1000,
    }),
    "operator_entered",
  );
  id = s.id;
  obs.approve(id, s.intentHash);
  const call = await obs.execute(id, {
    tool: "firecrawl_extract",
    url: "https://example.com",
    requestKey: "one",
    domains: [],
    statedReason: "Read the known source",
  });
  const out = obs.outcome(id, {
    requestKey: "final",
    text: "Synthetic output",
    evidenceCallIds: [call.id],
  });
  const review = obs.evaluate(id, {
    outcomeId: out.outcomes[0].id,
    reviewer: { kind: "assistant_reported" },
    criteria: [
      {
        criterionId: s.criteria[0].id,
        verdict: "unknown",
        note: "Not independently assessed",
        evidenceCallIds: [call.id],
      },
    ],
  });
  const opened = obs.openCase(
    id,
    review.evaluations[0].id,
    "Synthetic review needs additional verification.",
  );
  obs.resolveCase(
    id,
    opened.cases[0].id,
    "resolved",
    "Fixture recorded without any financial transaction.",
  );
});
afterEach(() => {
  store.close();
  Object.assign(config.keys, keys);
});
const exported = () => ({
  version: "private-evidence-v1",
  session: obs.db.detail(id)!,
});
it("verifies a complete exported workflow without trusting its claimed integrity flag", () => {
  const e = exported();
  e.session.integrity = false;
  expect(verifyPrivateEvidence(e).valid).toBe(true);
});
it("detects changed output text even when the audit chain itself is intact", () => {
  const e = exported();
  e.session.outcomes[0].text = "Changed answer";
  expect(verifyPrivateEvidence(e)).toMatchObject({ valid: false });
  expect(verifyPrivateEvidence(e).errors.join(" ")).toContain(
    "recorded submission",
  );
});
it("detects changed source content in the materialized receipt", () => {
  const e = exported();
  e.session.calls[0].result!.text = "Changed source";
  expect(verifyPrivateEvidence(e).errors.join(" ")).toContain(
    "recorded result",
  );
});
it("detects altered criterion judgments and a rewritten budget ledger", () => {
  const e = exported();
  e.session.evaluations[0].score = 100;
  e.session.spentMicros = 0;
  const result = verifyPrivateEvidence(e);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("recorded review");
  expect(result.errors.join(" ")).toContain("budget ledger");
});
it("detects chain edits, missing evidence, and changed consent", () => {
  const e = exported();
  e.session.events[0].data.objective = "Changed intent";
  e.session.calls = [];
  e.session.commercialConsent = false;
  const errors = verifyPrivateEvidence(e).errors.join(" ");
  expect(errors).toContain("Audit chain mismatch");
  expect(errors).toContain("missing evidence");
  expect(errors).toContain("Sharing preference");
});
it("detects a changed accepted intent and closed-case resolution", () => {
  const e = exported();
  e.session.budgetMicros = 2000;
  e.session.cases[0].resolution = "A different resolution";
  const errors = verifyPrivateEvidence(e).errors.join(" ");
  expect(errors).toContain("fingerprint");
  expect(errors).toContain("recorded resolution");
});
it("rejects malformed and summary exports without exposing source content", () => {
  for (const input of [
    null,
    {},
    { version: "observation-summary-v1" },
    { version: "private-evidence-v1", session: { id: "incomplete" } },
  ])
    expect(verifyPrivateEvidence(input).valid).toBe(false);
  expect(JSON.stringify(verifyPrivateEvidence(exported()))).not.toContain(
    "Synthetic source evidence",
  );
});
it("accepts a session still awaiting approval and treats it as an incomplete workflow", () => {
  const s = obs.create(
    sessionInput.parse({
      title: "Unapproved fixture",
      objective: "Record an intent without starting work.",
      criteria: [{ text: "No provider call", weight: 1 }],
      budgetMicros: 0,
    }),
    "agent_reported",
  );
  expect(
    verifyPrivateEvidence({
      version: "private-evidence-v1",
      session: obs.db.detail(s.id),
    }).valid,
  ).toBe(true);
});

it("verifies backend authorization and detects changes to its source or policy", async () => {
  const s = obs.createAgentSession(
    agentSessionInput.parse({
      title: "Automatic authorization fixture",
      objective: "Research without a consumer approval step.",
      criteria: [{ text: "Preserves backend policy provenance" }],
    }),
  );
  const call = await obs.execute(s.id, {
    tool: "firecrawl_extract",
    url: "https://example.com",
    requestKey: "auto",
    domains: [],
    statedReason: "Read the fixture source",
  });
  obs.outcome(s.id, {
    requestKey: "auto-final",
    text: "Synthetic automatic output",
    evidenceCallIds: [call.id],
  });
  const clean = {
    version: "private-evidence-v1",
    session: obs.db.detail(s.id)!,
  };
  expect(verifyPrivateEvidence(clean)).toMatchObject({
    valid: true,
    errors: [],
  });
  for (const source of [undefined, "workspace_operator"] as const) {
    const changed = structuredClone(clean);
    changed.session.authorizationSource = source;
    expect(verifyPrivateEvidence(changed).valid).toBe(false);
  }
  const budget = structuredClone(clean);
  budget.session.budgetMicros++;
  expect(verifyPrivateEvidence(budget).errors.join(" ")).toContain(
    "Backend authorization",
  );
  const event = structuredClone(clean);
  event.session.events.find((e) => e.type === "intent_authorized")!.provenance =
    "workspace_review";
  expect(verifyPrivateEvidence(event).errors.join(" ")).toContain(
    "Backend authorization",
  );
});

it("detects altered workspace sharing policy metadata", () => {
  const e = exported();
  e.session.sharingPolicy = "unrecorded-policy";
  expect(verifyPrivateEvidence(e).errors.join(" ")).toContain("Sharing policy");
});
