// Isolated packaged-runtime check. No provider keys or external network requests.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const base = "http://127.0.0.1:3001/api/observations";
const headers = {
  Authorization: `Bearer ${process.env.API_TOKEN}`,
  "Content-Type": "application/json",
};
const record = "/app/data/observation-smoke.json";
const request = async (path, body) => {
  const response = await fetch(base + path, {
    headers,
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `Observation HTTP ${response.status}`);
  return response.json();
};
if (process.argv[2] === "persist") {
  const saved = JSON.parse(await readFile(record, "utf8"));
  const session = await request(`/${saved.id}`);
  assert.equal(session.intentHash, saved.intentHash);
  assert.equal(session.integrity, true);
  assert.equal(session.outcomes[0].text, "Synthetic container output.");
  assert.equal(session.evaluations[0].score, null);
  assert.equal(session.evaluations[0].coverage, 0);
  assert.equal(session.cases[0].status, "resolved");
  assert.equal(session.spentMicros, 0);
  assert.equal(session.commercialConsent, false);
  assert.ok(session.events.some((e) => e.type === "client_observed"));
  console.log(
    "Packaged observation intent, output, evaluation, case, and client history survived restart.",
  );
} else {
  assert.equal((await fetch(base)).status, 401);
  const client = new Client({
    name: "Container integration fixture",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/mcp-stdio.js"],
    env: { API_TOKEN: process.env.API_TOKEN },
    stderr: "pipe",
  });
  const tool = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(tools.length, 8);
    assert.ok(!tools.includes("approve"));
    const s = await tool("record_intent", {
      title: "Synthetic container validation",
      objective: "Preserve a fixture output across a packaged server restart.",
      criteria: [
        { text: "Independent verification remains unknown", weight: 1 },
      ],
      budgetMicros: 0,
      model: "Synthetic fixture",
      host: "Container test",
    });
    assert.equal(s.approvalRequired, true);
    assert.equal(s.commercialConsent, false);
    await request(`/${s.id}/approve`, { intentHash: s.intentHash });
    const unavailable = await client.callTool({
      name: "firecrawl_extract",
      arguments: {
        sessionId: s.id,
        url: "https://example.com",
        requestKey: "unconfigured",
      },
    });
    assert.equal(unavailable.isError, true);
    const out = await tool("submit_outcome", {
      sessionId: s.id,
      requestKey: "final",
      text: "Synthetic container output.",
      evidenceCallIds: [],
    });
    const reviewed = await request(`/${s.id}/evaluate`, {
      outcomeId: out.outcomeId,
      reviewer: {
        kind: "assistant_reported",
        label: "Synthetic container fixture",
      },
      criteria: [
        {
          criterionId: s.criteria[0].id,
          verdict: "unknown",
          note: "This synthetic output has not been independently verified.",
          evidenceCallIds: [],
        },
      ],
    });
    const withCase = await request(`/${s.id}/cases`, {
      evaluationId: reviewed.evaluations[0].id,
      reason: "Synthetic persistence check for review case history.",
    });
    await request(`/${s.id}/cases/${withCase.cases[0].id}`, {
      status: "resolved",
      resolution: "Fixture completed without a provider call or payment.",
    });
    const summary = await request(`/${s.id}/export`);
    assert.equal(summary.includesResearchContent, false);
    assert.equal(summary.estimatedMicros, 0);
    assert.ok(!JSON.stringify(summary).includes("Synthetic container output"));
    await writeFile(
      record,
      JSON.stringify({ id: s.id, intentHash: s.intentHash }),
      { mode: 0o600 },
    );
    console.log(
      "Packaged MCP transport, authenticated API, approval, missing-key guard, output/review/case, and minimized export: passed.",
    );
  } finally {
    await client.close();
    await transport.close();
  }
}
