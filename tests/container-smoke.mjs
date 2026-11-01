// Runs inside an isolated container with no provider keys. No external API requests.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3001";
const headers = {
  Authorization: `Bearer ${process.env.API_TOKEN}`,
  "Content-Type": "application/json",
};
assert.equal((await fetch(base + "/healthz")).status, 200);
assert.equal((await fetch(base + "/api/tasks")).status, 401);
if (process.argv[2] === "persist") {
  const id = await readFile("/app/data/smoke-task-id", "utf8");
  const response = await fetch(base + `/api/tasks/${id}`, { headers });
  assert.equal(response.status, 200);
  const task = await response.json();
  assert.equal(task.status, "ready");
  assert.equal(task.events[0].type, "intent_created");
  console.log("Container persistence after restart: passed.");
} else {
  const response = await fetch(base + "/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "Container acceptance without external API operations",
      query: "container smoke",
      criteria: ["Runtime persistence works"],
      requiredCount: 1,
      budgetMicros: 10000,
      domains: [],
      mode: "route",
      preference: "balanced",
      consent: false,
    }),
  });
  assert.equal(response.status, 201);
  const task = await response.json();
  await writeFile("/app/data/smoke-task-id", task.id, { mode: 0o600 });
  const run = await fetch(base + `/api/tasks/${task.id}/run`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(run.status, 409);
  console.log(
    "Container health, authentication, intent persistence, and missing-key guard: passed.",
  );
}
