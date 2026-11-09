// Runs only in an isolated CI container/database. No external Auth or provider requests.
import assert from "node:assert/strict";
import pg from "pg";
const { Store } = await import(`${process.cwd()}/build/store.js`);
const { Observatory } = await import(`${process.cwd()}/build/observation.js`);
import { readFile } from "node:fs/promises";
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const mode = process.argv[2];
const connection = process.env.DATABASE_URL;
assert.ok(connection, "Explicit fixture connection required");
const pool = new pg.Pool({ connectionString: connection });
try {
  if (mode === "recovery-target") {
    await pool.query(
      "CREATE DATABASE octolab_container_restored TEMPLATE template0",
    );
  } else if (mode === "bootstrap") {
    const manifest = JSON.parse(
      await readFile("release-manifest.json", "utf8"),
    );
    const expected = Object.keys(manifest.files).filter(
      (p) => p.startsWith("supabase/migrations/") && p.endsWith(".sql"),
    ).length;
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM octolab_migrations.versions",
        )
      ).rows[0].n,
      expected,
    );
    await pool.query(
      "INSERT INTO octolab.workspaces(id,name) VALUES($1,'Container fixture A'),($2,'Container fixture B')",
      ids,
    );
    const store = new Store(":unused:", connection, ids[0]);
    try {
      const obs = new Observatory(store);
      await obs.ready;
      for (const [index, id] of ids.entries())
        await store.scope.run(id, async () => {
          await obs.createAgentSession({
            title: `Container PostgreSQL fixture ${index}`,
            objective:
              "Preserve isolated evidence across runtime restart and restore",
            criteria: [{ text: "Fixture only", weight: 1 }],
            constraints: "",
            model: "fixture",
            host: "container-ci",
          });
        });
    } finally {
      await store.close();
    }
  } else {
    const port = process.env.PORT || "3001",
      origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    for (const path of [
      "/api/observations",
      "/api/workspace/usage",
      "/api/workspace/provider-billing",
    ])
      assert.equal((await fetch(origin + path)).status, 401);
    const auth = await (await fetch(`${origin}/api/auth/config`)).json();
    assert.equal(auth.enabled, true);
    const store = new Store(":unused:", connection, ids[0]);
    try {
      const obs = new Observatory(store);
      await obs.ready;
      for (const [index, id] of ids.entries())
        await store.scope.run(id, async () => {
          const sessions = await obs.db.list();
          assert.equal(sessions.length, 1);
          assert.equal(
            sessions[0].title,
            `Container PostgreSQL fixture ${index}`,
          );
          assert.equal((await obs.db.detail(sessions[0].id)).integrity, true);
        });
    } finally {
      await store.close();
    }
    console.log(
      "Packaged PostgreSQL runtime is healthy, denies unauthenticated access, preserves audit chains and isolates fixture workspaces.",
    );
  }
} finally {
  await pool.end();
}
