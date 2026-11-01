import { config } from "./config.js";
import { Store } from "./store.js";
const days = Number(process.env.RETENTION_DAYS ?? 30);
if (!Number.isInteger(days) || days < 1)
  throw new Error("RETENTION_DAYS must be a positive integer");
const store = new Store(config.dbPath);
const cutoff = Date.now() - days * 86400000;
const result = store.db
  .prepare(
    "DELETE FROM tasks WHERE json_extract(body,'$.updatedAt') < ? AND json_extract(body,'$.status') != 'running'",
  )
  .run(new Date(cutoff).toISOString());
store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
console.log(
  `Deleted ${result.changes} tasks older than ${days} days and their event histories.`,
);
store.close();
