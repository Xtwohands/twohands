import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { digest } from "./observation-store.js";

export interface DatabaseSnapshot {
  tables: { schema: string; table: string; rows: number; sha256: string }[];
  sequences: Record<string, unknown>[];
  security: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  audit: { events: number; chains: number; valid: boolean };
  keyLedgerValid: boolean;
}
export const sqlIdentifier = (value: string) =>
  `"${value.replaceAll('"', '""')}"`;
export async function beginBackupSnapshot(client: PoolClient) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
}
/** Stream rows in a fixed byte order; only digests/counts are retained in the manifest. */
export async function databaseSnapshot(
  client: PoolClient,
): Promise<DatabaseSnapshot> {
  const tables = (
    await client.query(
      "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('octolab','octolab_migrations') AND c.relkind='r' ORDER BY 1,2",
    )
  ).rows as { schema: string; name: string }[];
  if (
    !tables.some((t) => t.schema === "octolab" && t.name === "workspaces") ||
    !tables.some(
      (t) => t.schema === "octolab_migrations" && t.name === "versions",
    )
  )
    throw new Error("Source is not a migrated octolab application.");
  const results: DatabaseSnapshot["tables"] = [];
  for (const table of tables) {
    const qualified = `${sqlIdentifier(table.schema)}.${sqlIdentifier(table.name)}`;
    await client.query(
      `DECLARE octolab_backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS body FROM ${qualified} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
    );
    const hash = createHash("sha256");
    let rows = 0;
    try {
      while (true) {
        const batch = await client.query(
          "FETCH FORWARD 1000 FROM octolab_backup_rows",
        );
        if (!batch.rowCount) break;
        for (const row of batch.rows) {
          hash.update(String(Buffer.byteLength(row.body)));
          hash.update(":");
          hash.update(row.body);
          rows++;
        }
      }
    } finally {
      await client.query("CLOSE octolab_backup_rows");
    }
    results.push({
      schema: table.schema,
      table: table.name,
      rows,
      sha256: hash.digest("hex"),
    });
  }
  const sequences: DatabaseSnapshot["sequences"] = [];
  for (const row of (
    await client.query(
      "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('octolab','octolab_migrations') AND c.relkind='S' ORDER BY 1,2",
    )
  ).rows) {
    const value = (
      await client.query(
        `SELECT last_value::text,is_called FROM ${sqlIdentifier(row.schema)}.${sqlIdentifier(row.name)}`,
      )
    ).rows[0];
    sequences.push({ schema: row.schema, name: row.name, ...value });
  }
  const security = (
    await client.query(
      "SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,has_table_privilege('octolab_runtime',c.oid,'SELECT') AS runtime_read,has_table_privilege('octolab_runtime',c.oid,'INSERT') AS runtime_insert,has_table_privilege('octolab_runtime',c.oid,'UPDATE') AS runtime_update,has_table_privilege('octolab_runtime',c.oid,'DELETE') AS runtime_delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='octolab' AND c.relkind='r' ORDER BY c.relname",
    )
  ).rows;
  const ledger = (
    await client.query(
      "SELECT workspace_id,source,COUNT(*)::integer AS entries,SUM(delta_units)::text AS balance_units FROM octolab.funding_ledger GROUP BY workspace_id,source ORDER BY workspace_id,source",
    )
  ).rows;
  const heads = new Map<string, string>();
  let valid = true,
    events = 0;
  await client.query(
    "DECLARE octolab_backup_audit NO SCROLL CURSOR FOR SELECT workspace_id,session_id,body FROM octolab.observation_events ORDER BY workspace_id,session_id,id",
  );
  try {
    while (true) {
      const batch = await client.query(
        "FETCH FORWARD 1000 FROM octolab_backup_audit",
      );
      if (!batch.rowCount) break;
      for (const event of batch.rows) {
        const key = JSON.stringify([event.workspace_id, event.session_id]),
          { hash, ...payload } = JSON.parse(event.body);
        if (
          payload.previousHash !== (heads.get(key) ?? "genesis") ||
          digest(payload) !== hash
        )
          valid = false;
        heads.set(key, hash);
        events++;
      }
    }
  } finally {
    await client.query("CLOSE octolab_backup_audit");
  }
  const inconsistent = await client.query(
    "SELECT 1 FROM octolab.workspace_api_keys k WHERE k.spent_micros <> COALESCE((SELECT SUM(s.amount_micros) FROM octolab.api_key_spend s WHERE s.workspace_id=k.workspace_id AND s.key_id=k.id AND s.state='settled'),0) OR k.reserved_micros <> COALESCE((SELECT SUM(s.amount_micros) FROM octolab.api_key_spend s WHERE s.workspace_id=k.workspace_id AND s.key_id=k.id AND s.state='reserved'),0) LIMIT 1",
  );
  return {
    tables: results,
    sequences,
    security,
    ledger,
    audit: { events, chains: heads.size, valid },
    keyLedgerValid: inconsistent.rowCount === 0,
  };
}
