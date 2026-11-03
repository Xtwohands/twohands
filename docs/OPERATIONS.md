# Privacy and operations

## Credentials and access

Except for explicitly enabled Firecrawl keyless extraction, provider keys are read from the Node server environment or local `.env` file. They never enter browser bundles, source control, SQLite events, or API responses. The Connections screen displays only whether a key is configured, not whether it has been verified.

By default the server binds to loopback. Non-loopback binding requires `API_TOKEN` with at least 24 characters. For remote use, place the service behind HTTPS and trusted access controls. The browser keeps the workspace token in memory only, clearing it on reload; provider credentials cannot be entered into the browser. Local API host validation and same-origin JSON writes reduce browser-based attacks against unauthenticated loopback deployments.

This is a single shared workspace. The token grants access to all local sessions and research tasks. It does not supply tenant isolation, roles, user identity, audit attribution, or buyer access control. Do not use this version for untrusted public users or confidential multi-tenant workloads.

## Local data

The default database is `data/apilayer.sqlite`; its directory is created with owner-only permissions. Normal operations append events and replace materialized session/task state. Observation events have a local SHA-256 chain; this checks internal chain consistency, not independent attestation or immutable external custody. WAL sidecars are part of the database's operational storage. Protect the directory and any backups as sensitive workspace data.

Internal storage includes prompts, criteria, normalized query arguments, source excerpts and URLs, evidence assessments, reviewer notes, routing/usage metadata, and estimates. Search providers receive the query and domain filters needed to perform the search; Firecrawl receives an explicitly selected source URL. Review the vendor's terms, data retention, and permitted use before processing sensitive requests.

Analytics consent defaults **off**. The task privacy control can withdraw it immediately or explicitly opt back in. The separate delete action removes a settled task and its event history from local storage; it is blocked while provider operations are active or reserved. Local task storage is necessary to use the workspace; the optional checkbox controls whether that task contributes to provider aggregates. The provider analytics API has an explicit field allowlist, excludes task content, and suppresses small cohorts. Cohort suppression is a basic safeguard, not a differential-privacy guarantee or proof of anonymity. Do not commercialize this feed without reviewing permissions, terms, licensing, and buyer requirements.

Sanitized trace exports omit prompts, queries, source URLs/content, organization names, reviewer notes, and request arguments. They retain task/call identifiers, timing, policy decisions, observed response metadata, and cost estimates. Company CSV exports intentionally contain the reviewed result and evidence links.

## Observation records and sharing

The MCP bridge exposes intent proposals, session reads, explicit provider tools, cached evidence, and output submission. Intent acceptance, evaluations, case handling, deletion, and the legacy sharing compatibility route are operator HTTP operations, absent from the MCP tool catalog. This is a local shared trust boundary; it is not a defense against another privileged local process accessing the operator API.

Each delivered output remains available as a separate version. An evaluation references an exact output ID, accepted intent hash, criterion verdicts, supporting call IDs, and a reported review source. Reviewing a prior version requires an explicit retrospective flag. Cases reference one exact evaluation and record their resolution; no money moves and no coverage is issued.

Observation summary exports omit the objective, constraints, criteria text, model label, output text, source content, URLs, queries, stated explanations, and reviewer/case notes. Private exports intentionally contain them. Identifiers and timestamps remain in summary exports; these are minimized records, not a promise of anonymity.

Commercial aggregate sharing is enabled for all observation sessions under workspace policy. Existing sessions are migrated once with an appended policy event; new sessions record the policy at creation. Per-session opt-out is no longer supported. The aggregate endpoint suppresses both overall and per-provider cohorts below the configured minimum (at least five). It contains only fixed provider names and aggregate execution counts/latency. Nothing is automatically sent to vendors. Stated explanations are retained locally and are not part of this aggregate feed. A future licensed data product needs a separate, explicit export contract and permissions.

## Retention

Default documented retention: **30 days**. Scheduling cleanup is the operator's responsibility; no background job silently deletes research. Stop the server before running maintenance.

```bash
RETENTION_DAYS=30 npm run retention
```

The command deletes expired research tasks and observation sessions with their evidence and event histories. It skips running research tasks, observation sessions with active provider calls, and observation sessions with open review cases. Expiration uses the last materialized update. Closed cases are subject to ordinary retention. Provider lab maintenance deletes expired reviewed plans and completed unlinked runs, while preserving running tests, recent usefulness reviews, unfinished plans, and runs linked by retained plans. It then checkpoints WAL and vacuums SQLite. MCP client connection metadata is operational history and remains until the workspace is removed; it contains client name/version and timestamps, not conversation content. A paused task is not a complete backup. Apply equivalent retention to exported files, screenshots, backups, and hosting volumes. Filesystem snapshots and external backups are outside this application's deletion control.

## Limits and pricing

| Variable                            | Default                  | Meaning                                                                                        |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `EXA_SEARCH_USD`                    | 0.007                    | Estimate for one search with text from up to 10 returned pages                                 |
| `TAVILY_SEARCH_USD`                 | 0.008                    | Estimate for one basic search                                                                  |
| `FIRECRAWL_SCRAPE_USD`              | 0.001                    | Estimate for one extraction                                                                    |
| `PROVIDER_TIMEOUT_MS`               | 20000                    | HTTP request deadline                                                                          |
| `PROVIDER_RPM`                      | 20                       | Process-local requests per provider per rolling minute                                         |
| `AGENT_SESSION_BUDGET_MICROS`       | 100000                   | Backend cap per automatically authorized MCP session ($0.10); 0 blocks positive-estimate calls |
| `PROVIDER_TEST_BUDGET_MICROS`       | 150000                   | Backend cap per controlled provider run ($0.15)                                                |
| `PROVIDER_TEST_DAILY_BUDGET_MICROS` | 500000                   | Controlled-test allowance per UTC start day ($0.50), separate from organic research            |
| `ANALYTICS_MIN_TASKS`               | 5                        | Minimum commercial export cohort, cannot be configured below 5                                 |
| `DB_PATH`                           | `./data/apilayer.sqlite` | Workspace database                                                                             |
| `HOST` / `PORT`                     | `127.0.0.1` / `3001`     | HTTP listener                                                                                  |

Prices are **configurable planning assumptions**, not verified current plan prices. Exa's default is $0.007 for Auto search with up to ten results and page text, checked against its published price card and five provider-reported responses on November 1, 2026. The prior $0.017 default double-counted an allowance for content. Historical receipts keep their original rate card and estimates. Vendor plans, search types, returned contents, credit packages, and discounts can change actual charges. Confirm the official price card and your account plan before use:

- https://exa.ai/pricing
- https://www.tavily.com/pricing
- https://www.firecrawl.dev/pricing

The ledger enforces the task cap against those configured estimates. Actual vendor charges can differ. Provider response usage is displayed separately when available and is not an invoice reconciliation. Set vendor-side caps and validate estimates before larger runs. Errors/timeouts conservatively retain estimates because their billing status is uncertain.

MCP sessions start automatically under backend policy. Consumers do not configure research spending or approve sessions; a shopping budget remains part of their product request. `AGENT_SESSION_BUDGET_MICROS` is read by the HTTP server, not accepted from the agent. Changing it affects new sessions after restart; existing sessions retain their recorded cap. Automatic authorization is an observed backend event, separate from human acceptance and commercial consent. The cap is per session, not an account-wide quota or tenant isolation mechanism. Existing manual operator sessions retain their explicit acceptance flow.

Each observation session and legacy research task has a maximum of 50 provider attempts across search and extraction. The rolling provider rate limit is shared across organic research and the provider lab within the process. Observation calls are explicitly selected by the external agent and are never automatically retried. Legacy research additionally limits each plan to five queries and two search attempts per query, with at most three legacy tasks active simultaneously. The legacy three-task limit does not apply to observation sessions; their admission uses accepted budgets, call counts, and shared provider rate limits. Run a single process per database; process-local limits are not distributed rate limiting. Database exclusive ownership prevents another server, retention command, or direct-database live runner from claiming that database while the server is running. Stop the server before maintenance.

## Optional keyless extraction

`FIRECRAWL_ALLOW_KEYLESS=true` explicitly opts into Firecrawl's documented free tier. The default remains false. Keyless requests send no Authorization header, use a zero-USD free-tier ledger entry, and preserve provider credit usage separately. They stop on HTTP 401/403/429 without automatic retry or paid upgrade. `FIRECRAWL_KEYLESS_MAX_REQUESTS` defaults to ten requests per server process (configurable 1–50), in addition to the task and rolling provider limits. This local cap does not reset the provider's daily per-IP quota; restarting is not a way to bypass provider refusal. Sign in and configure a legitimate key if the allowance is unavailable.

The observation MCP catalog currently requires a configured Firecrawl key; optional keyless extraction is supported only by the legacy research workflow.

The free tier can change. See [actual live validation](LIVE_VALIDATION.md) and the current [official keyless documentation](https://www.firecrawl.dev/blog/firecrawl-keyless-launch). Firecrawl remains a separate extraction capability; it is not silently substituted for the specified Exa/Tavily search comparison.

## HTTPS proxies

The start/development/CLI scripts enable Node's environment proxy support (`--use-env-proxy`, requiring Node 24.5+). This respects configured HTTP_PROXY/HTTPS_PROXY/NO_PROXY rather than attempting direct egress in managed environments. TLS verification remains enabled. If your proxy uses a private CA, provide NODE_EXTRA_CA_CERTS to the Node process. Docker builds support an optional BuildKit `proxy_ca` secret, mounted only during npm installation; runtime containers need the appropriate read-only CA mount separately. No session CA or proxy credential is embedded in the image.

## Shutdown, recovery, and health

SIGTERM/SIGINT stops accepting connections, asks active legacy plans and controlled provider tests to stop between calls, and waits for in-flight legacy, observation, and lab operations to settle. If the process is killed before settlement, startup conservatively consumes outstanding estimates, records interrupted-call and settlement events, and marks affected tasks partial. Observation calls are marked interrupted and retain a conservative estimate; the same request key returns the recorded interruption rather than repeating the provider operation. Repeated recovery does not charge the same reservation twice.

`GET /healthz` tests the database connection and returns only `{ "ok": true }`. It does not verify vendor credentials or prove an external provider is healthy. `/api/health` is authenticated when a workspace token is configured and provides connection configuration, not vendor uptime.

## Deployment artifact

The Dockerfile builds both the browser and server, installs runtime dependencies separately, and runs as the non-root `node` user. Use a persistent `/app/data` volume. The server deliberately refuses public binding without a long token. Supply secrets through your hosting system and terminate TLS in front of the container.

The Docker artifact passes local and CI build/runtime/restart checks. It still has to be configured and validated in the target deployment environment; it is not a claim that a hosted service has been deployed. Buyer interviews, vendor terms review, and willingness-to-pay validation remain operational tasks.
