# Privacy and operations

## Credentials and access

Provider keys are read from the Node server environment or local `.env` file. They never enter browser bundles, source control, SQLite events, or API responses. The Connections screen displays only whether a key is configured, not whether it has been verified.

By default the server binds to loopback. Non-loopback binding requires `API_TOKEN` with at least 24 characters. For remote use, place the service behind HTTPS and trusted access controls. The browser keeps the workspace token in memory only, clearing it on reload; provider credentials cannot be entered into the browser. Local API host validation and same-origin JSON writes reduce browser-based attacks against unauthenticated loopback deployments.

This is a single shared workspace. The token grants access to all local tasks. It does not supply tenant isolation, roles, user identity, audit attribution, or buyer access control. Do not use this version for untrusted public users or confidential multi-tenant workloads.

## Local data

The default database is `data/apilayer.sqlite`; its directory is created with owner-only permissions. Normal operations append events and replace materialized task state. WAL sidecars are part of the database's operational storage. Protect the directory and any backups as sensitive workspace data.

Internal storage includes prompts, criteria, normalized query arguments, source excerpts and URLs, evidence assessments, reviewer notes, routing/usage metadata, and estimates. Search providers receive the query and domain filters needed to perform the search; Firecrawl receives an explicitly selected source URL. Review the vendor's terms, data retention, and permitted use before processing sensitive requests.

Analytics consent defaults **off**. Local task storage is necessary to use the workspace; the optional checkbox controls whether that task contributes to provider aggregates. The provider analytics API has an explicit field allowlist, excludes task content, and suppresses small cohorts. Cohort suppression is a basic safeguard, not a differential-privacy guarantee or proof of anonymity. Do not commercialize this feed without reviewing permissions, terms, licensing, and buyer requirements.

Sanitized trace exports omit prompts, queries, source URLs/content, organization names, reviewer notes, and request arguments. They retain task/call identifiers, timing, policy decisions, observed response metadata, and cost estimates. Company CSV exports intentionally contain the reviewed result and evidence links.

## Retention

Default documented retention: **30 days**. Scheduling cleanup is the operator's responsibility; no background job silently deletes research. Stop the server before running maintenance.

```bash
RETENTION_DAYS=30 npm run retention
```

The command deletes expired tasks and their event histories, skips tasks marked running, checkpoints WAL, and vacuums SQLite. A paused task is not a complete backup. Apply equivalent retention to exported files, screenshots, backups, and hosting volumes. Filesystem snapshots and external backups are outside this application's deletion control.

## Limits and pricing

| Variable               | Default                  | Meaning                                                        |
| ---------------------- | ------------------------ | -------------------------------------------------------------- |
| `EXA_SEARCH_USD`       | 0.015                    | Estimate for one search with text from up to 10 returned pages |
| `TAVILY_SEARCH_USD`    | 0.008                    | Estimate for one basic search                                  |
| `FIRECRAWL_SCRAPE_USD` | 0.001                    | Estimate for one extraction                                    |
| `PROVIDER_TIMEOUT_MS`  | 20000                    | HTTP request deadline                                          |
| `PROVIDER_RPM`         | 20                       | Process-local requests per provider per rolling minute         |
| `ANALYTICS_MIN_TASKS`  | 5                        | Minimum consented cohort, cannot be configured below 5         |
| `DB_PATH`              | `./data/apilayer.sqlite` | Workspace database                                             |
| `HOST` / `PORT`        | `127.0.0.1` / `3001`     | HTTP listener                                                  |

Prices are **configurable planning assumptions**, not verified current plan prices. Exa's default includes an allowance for text retrieval; vendor plans, search types, returned contents, credit packages, and discounts can change actual charges. Confirm the official price card and your account plan before use:

- https://exa.ai/pricing
- https://www.tavily.com/pricing
- https://www.firecrawl.dev/pricing

The ledger enforces the task cap against those configured estimates. Actual vendor charges can differ. Provider response usage is displayed separately when available and is not an invoice reconciliation. Set vendor-side caps and validate estimates before larger runs. Errors/timeouts conservatively retain estimates because their billing status is uncertain.

Each task has a maximum of 50 paid attempts across search and extraction; each run has at most five queries and two search attempts per query. At most three tasks can perform operations simultaneously. Run a single process per database; process-local limits are not distributed rate limiting.

## HTTPS proxies

The start/development/CLI scripts enable Node's environment proxy support (`--use-env-proxy`, requiring Node 24.5+). This respects configured HTTP_PROXY/HTTPS_PROXY/NO_PROXY rather than attempting direct egress in managed environments. TLS verification remains enabled. If your proxy uses a private CA, provide NODE_EXTRA_CA_CERTS to the Node process. Docker builds support an optional BuildKit `proxy_ca` secret, mounted only during npm installation; runtime containers need the appropriate read-only CA mount separately. No session CA or proxy credential is embedded in the image.

## Shutdown, recovery, and health

SIGTERM/SIGINT stops accepting connections, asks active plans to stop between calls, and waits for in-flight operations to settle. If the process is killed before settlement, startup conservatively consumes outstanding estimates, records interrupted-call and settlement events, and marks affected tasks partial. Repeated recovery does not charge the same reservation twice.

`GET /healthz` tests the database connection and returns only `{ "ok": true }`. It does not verify vendor credentials or prove an external provider is healthy. `/api/health` is authenticated when a workspace token is configured and provides connection configuration, not vendor uptime.

## Deployment artifact

The Dockerfile builds both the browser and server, installs runtime dependencies separately, and runs as the non-root `node` user. Use a persistent `/app/data` volume. The server deliberately refuses public binding without a long token. Supply secrets through your hosting system and terminate TLS in front of the container.

The Docker artifact passes local and CI build/runtime/restart checks. It still has to be configured and validated in the target deployment environment; it is not a claim that a hosted service has been deployed. Buyer interviews, vendor terms review, and willingness-to-pay validation remain operational tasks.
