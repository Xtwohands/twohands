import { config } from "./config.js";
import { Store } from "./store.js";
import { ObservationStore } from "./observation-store.js";
const days = Number(process.env.RETENTION_DAYS ?? 30);
if (!Number.isInteger(days) || days < 1)
  throw new Error("RETENTION_DAYS must be a positive integer");
const store = new Store(config.dbPath);
new ObservationStore(store);
const cutoff = Date.now() - days * 86400000;
const result = store.db
  .prepare(
    "DELETE FROM tasks WHERE json_extract(body,'$.updatedAt') < ? AND json_extract(body,'$.status') != 'running'",
  )
  .run(new Date(cutoff).toISOString());
const observations = store.db
  .prepare(
    `DELETE FROM observation_sessions
 WHERE json_extract(body,'$.updatedAt') < ?
 AND NOT EXISTS (SELECT 1 FROM observation_calls c WHERE c.session_id=observation_sessions.id AND json_extract(c.body,'$.status')='running')
 AND NOT EXISTS (SELECT 1 FROM json_each(observation_sessions.body,'$.cases') c WHERE json_extract(c.value,'$.status')='open')`,
  )
  .run(new Date(cutoff).toISOString());
store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
console.log(
  `Deleted ${result.changes} research tasks and ${observations.changes} observation sessions older than ${days} days, including their evidence and audit histories. Active calls and open review cases were retained.`,
);
store.close();
