import { config } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { claimRuntime } from "./migration.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";
import { Observatory } from "./observation.js";
if (
  !["127.0.0.1", "localhost", "::1"].includes(config.host) &&
  config.token.length < 24
)
  throw new Error(
    "Set API_TOKEN to at least 24 characters before binding beyond loopback.",
  );
if (!["sqlite", "postgres"].includes(config.storageBackend))
  throw new Error("STORAGE_BACKEND must be sqlite or postgres.");
if (config.storageBackend === "postgres" && !config.databaseUrl)
  throw new Error("Set DATABASE_URL before choosing Postgres.");
const store = new Store(
  config.dbPath,
  config.storageBackend === "postgres" ? config.databaseUrl : undefined,
  config.legacyWorkspaceId,
);
const releaseRuntime =
  store.db instanceof PostgresDatabase
    ? await claimRuntime(store.db)
    : undefined;
if (store.db instanceof PostgresDatabase) {
  const legacy = await store.db.pool.query(
    "SELECT id FROM octolab.workspaces WHERE id=$1",
    [store.legacyWorkspaceId],
  );
  if (!legacy.rowCount)
    throw new Error(
      "Legacy workspace was not found. Complete and verify the explicit import before cutover.",
    );
}
await store.recover();
const engine = new Engine(store);
const observatory = new Observatory(store, undefined, engine.timestamps);
await observatory.ready;
await observatory.db.recover();
const app = createApp(store, engine, observatory);
await app.locals.providerLab.recover();
const server = app.listen(config.port, config.host, () =>
  console.log(
    `APILayer listening at http://${config.host}:${config.port}; provider credentials stay on the server.`,
  ),
);
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    let httpClosed = false;
    server.close(() => {
      httpClosed = true;
    });
    for (const id of engine.active) await engine.cancel(id);
    for (const id of app.locals.providerLab.active)
      app.locals.providerLab.cancel(id);
    const deadline = setTimeout(
      () => process.exit(1),
      Math.max(config.timeoutMs, 60000) + 3000,
    );
    deadline.unref();
    const drain = setInterval(async () => {
      if (
        httpClosed &&
        engine.active.size === 0 &&
        observatory.active.size === 0 &&
        app.locals.providerLab.active.size === 0 &&
        app.locals.funding.active.size === 0 &&
        app.locals.stripeFunding.active.size === 0 &&
        app.locals.stripeFunding.creating.size === 0
      ) {
        clearInterval(drain);
        clearTimeout(deadline);
        await releaseRuntime?.();
        await store.close();
        process.exit(0);
      }
    }, 50);
  });
