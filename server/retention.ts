import { config } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { claimRuntime } from "./migration.js";
import { Store } from "./store.js";
import { ObservationStore } from "./observation-store.js";
import { ProviderLab } from "./provider-lab.js";
const days = Number(process.env.RETENTION_DAYS ?? 30);
if (!Number.isInteger(days) || days < 1)
  throw new Error("RETENTION_DAYS must be a positive integer");
if (config.storageBackend === "postgres" && !config.databaseUrl)
  throw new Error("Set DATABASE_URL before Postgres maintenance.");
const store = new Store(
  config.dbPath,
  config.storageBackend === "postgres" ? config.databaseUrl : undefined,
  config.legacyWorkspaceId,
);
const release =
  store.db instanceof PostgresDatabase
    ? await claimRuntime(store.db)
    : undefined;
new ObservationStore(store);
const cutoff = Date.now() - days * 86400000;
const lab = await new ProviderLab(store).pruneOlderThan(
  new Date(cutoff).toISOString(),
);
const result = await store.db
  .prepare(
    "DELETE FROM tasks WHERE json_extract(body,'$.updatedAt') < ? AND json_extract(body,'$.status') != 'running'",
  )
  .run(new Date(cutoff).toISOString());
const observations = await store.db
  .prepare(
    `DELETE FROM observation_sessions
 WHERE json_extract(body,'$.updatedAt') < ?
 AND NOT EXISTS (SELECT 1 FROM observation_calls c WHERE c.session_id=observation_sessions.id AND json_extract(c.body,'$.status')='running')
 AND NOT EXISTS (SELECT 1 FROM json_each(observation_sessions.body,'$.cases') c WHERE json_extract(c.value,'$.status')='open')`,
  )
  .run(new Date(cutoff).toISOString());
if (store.db.dialect === "sqlite")
  await store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
console.log(
  `Deleted ${result.changes} research tasks, ${observations.changes} observation sessions, ${lab.runs} provider test runs, and ${lab.plans} reviewed test plans older than ${days} days, including their evidence and audit histories. Active calls, open review cases, unfinished test plans, and linked provider tests were retained.`,
);
await release?.();
await store.close();
