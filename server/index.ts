import { config } from "./config.js";
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
const store = new Store(config.dbPath);
store.recover();
const engine = new Engine(store);
const observatory = new Observatory(store, undefined, engine.timestamps);
observatory.db.recover();
const app = createApp(store, engine, observatory);
app.locals.providerLab.recover();
const server = app.listen(config.port, config.host, () =>
  console.log(
    `APILayer listening at http://${config.host}:${config.port}; provider credentials stay on the server.`,
  ),
);
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const id of engine.active) engine.cancel(id);
    for (const id of app.locals.providerLab.active)
      app.locals.providerLab.cancel(id);
    server.close();
    const deadline = setTimeout(() => process.exit(1), config.timeoutMs + 3000);
    deadline.unref();
    const drain = setInterval(() => {
      if (
        engine.active.size === 0 &&
        observatory.active.size === 0 &&
        app.locals.providerLab.active.size === 0
      ) {
        clearInterval(drain);
        clearTimeout(deadline);
        store.close();
        process.exit(0);
      }
    }, 50);
  });
