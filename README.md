# APILayer

A general-purpose tool router and observation layer for **Claude, Codex, and other MCP hosts**. People bring their own tasks and continue a free-flowing conversation with their AI. APILayer supplies provider tools and records intent, tool choices, evidence, and outcomes; it does not prescribe a task category or a fixed research workflow. Its dashboard is for inspection, evaluation, and review.

The local MCP server works with Claude desktop and Codex CLI. Both have completed live research sessions through it. See [validation evidence](docs/OBSERVATION_VALIDATION.md) for the exact scope and limitations.

The [product direction](docs/PRODUCT_DIRECTION.md) connects this evidence to future model evaluation, refund review, and consented tool-company feedback, and identifies what still needs to be established for each.

The sidebar now includes a **Tool company** demo and **Provider lab**. Explore illustrative company insights, turn findings into test plans, and compare real controlled provider samples separately from organic agent choices. See the [provider lab guide](docs/PROVIDER_LAB.md).

## Run locally

Requires Node.js 24.5+ and npm.

```bash
npm ci
cp .env.example .env
# Add the provider keys you want to use. Keep them out of VITE_ variables.
npm run build
npm start
```

Open [the dashboard](http://127.0.0.1:3001/#sessions). Exa and Tavily provide search; Firecrawl extracts a known public HTTPS page. Missing providers stay unavailable. Intent recording, review, and history work without provider keys.

For development, `npm run dev` runs the API on port 3001 and Vite on port 5173.

## Connect an agent

Keep the local server running. In another terminal:

```bash
npm run mcp:install
```

The installer merges the project’s `.mcp.json`, Claude desktop’s macOS configuration, and Codex’s MCP configuration when its CLI is on PATH. Existing files are backed up before changes; other servers are preserved. It stores absolute local paths, not API key values. Restart Claude desktop, enable the project server in Claude Code, or start a new Codex session. Host tool-approval settings are left in place.

You can target one client with `npm run mcp:install -- claude`, `-- codex`, or `-- project`. See [MCP setup and troubleshooting](docs/MCP.md), including custom ports and noninteractive tests.

1. Ask the external agent a normal question and tell it to use APILayer.
2. The agent records intent internally. The backend starts the session automatically under its configured spending policy; the consumer does not approve sessions or choose a research budget.
3. The agent discovers options, chooses providers explicitly, inspects evidence, and submits its final output.
4. Review the output against each criterion. Pass, fail, and unknown are separate; link supporting calls and explain judgments.
5. If needed, open a review case against a particular evaluation. Earlier outputs and retrospective reviews stay attached to their own versions.

Set `AGENT_SESSION_BUDGET_MICROS` on the backend to control the per-session research cap (default 100000 = $0.10; 0 blocks positive-estimate calls). This is separate from any shopping budget in a user's request. `record_intent` exposes no budget input or approval link. Backend authorization is recorded as an observed policy event, not human approval. The dashboard remains an operator inspection and review surface. Its manual intent flow remains available for operator-created sessions. APILayer’s MCP tool catalog contains no approval, evaluation, consent, payment, or refund tool.

## What gets recorded

| Record             | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Accepted intent    | Fixed objective, weighted criteria, constraints, budget, and a fingerprint of that accepted version    |
| Tool options       | The catalog returned to the agent; it does not prove every option was considered                       |
| Tool selection     | The explicit provider the caller requested; no automatic provider routing or fallback in this workflow |
| Stated explanation | An optional agent-supplied decision summary, separate from observed execution                          |
| Evidence           | Provider results, API/page status, timings, estimates, and extraction truncation metadata              |
| Output             | The agent’s actual submitted answer, with immutable versions and supporting call IDs                   |
| Evaluation         | Criterion judgments, evidence links, review source, score, coverage, and the exact output version      |
| Review case        | A documented shortfall and its resolution, linked to an evaluation                                     |

MCP exposes actions and supplied explanations, **not private internal reasoning or the entire host conversation**. Calls made outside APILayer are not observed. Client and model names are reported identities, not independent attestations.

## Evaluation and commercial boundaries

- Intent match is the weighted pass fraction among assessed criteria. Coverage separately reports how much of the rubric was assessed. Unknown is not a failure or a fabricated neutral score.
- Model summaries use one latest, fully reviewed output per session and withhold aggregate scores until five eligible sessions. Unknown model identities stay unscored. These are local review summaries across the recorded tasks, not controlled general-accuracy benchmarks.
- Human-reported and assistant-reported reviews are labeled. Reviewer identity is not independently verified. An assistant’s evaluation is not converted into a human assessment.
- Review cases do not issue money, promise insurance coverage, determine eligibility, or create a payment entitlement.
- Commercial aggregate sharing starts off for each session. Consent can be withdrawn. Exports suppress small provider cohorts and omit raw intent, answers, queries, URLs, and explanations. Nothing is automatically sent or sold to vendors.
- Summary export omits research text and free-form model labels. Private evidence export intentionally contains the complete local record. Local hash-chain consistency is not third-party attestation or protection against an operator rewriting the database.

## Reliability and operations

Calls reserve integer USD micro-units transactionally against configured estimates. Exact request-key retries reuse receipts, including across restarts; uncertain interrupted calls are retained and conservatively settled without automatically repeating provider work. Output retries return the original output version’s receipt. Provider billing and model-host subscription/token costs are not reconciled by this ledger.

The workspace is single-user and local by default. Set a long `API_TOKEN` before binding beyond loopback; use HTTPS and trusted access controls for any remote deployment. The MCP bridge intentionally accepts only loopback HTTP destinations. Run one server per SQLite database. See [privacy and operations](docs/OPERATIONS.md).

Earlier deterministic routing runs remain available at [Research tools](http://127.0.0.1:3001/research/#workspace). Their original data and workflows are preserved and explicitly distinguished from external-agent decisions. See [the earlier research workflow](docs/RESEARCH_WORKFLOW.md).

## Verify

```bash
npm run check
npx playwright install chromium
npm run test:e2e
npm run format:check
```

Tests use isolated fixtures and temporary databases. They cover protocol transport, authentication, approval boundaries, budgets, idempotency, real process interruption, retained evidence, output/review versions, cases, consent, exports, mobile navigation, accessibility, and safe Markdown rendering.

A reproducible durability workload is available without any external provider calls:

```bash
SOAK_SECONDS=60 npm run test:soak
```

Live checks require a deliberately accepted budget and configured provider credentials. Never treat fixture results as provider or model performance. The earlier `npm run smoke:live` command makes paid search calls and requires its explicit budget setting; see [its documentation](docs/RESEARCH_WORKFLOW.md).

For the separate provider lab, the backend supplies the run and daily spending caps. A full fifteen-call suite is $0.080 at default estimates. Consumer sessions have no approval step. To exercise only synthetic lab workloads without network calls, run `SOAK_SECONDS=60 npm run test:soak:providers`.

## Verify an exported evidence record

Export private evidence from a session’s Record & controls tab, then run:

```bash
npm run verify:evidence -- /path/to/private-evidence.json
```

This offline check compares the intent fingerprint, audit chain, captured calls, output/review links, estimated ledger, case resolutions, and consent state. It makes no network requests and does not modify the file. A passing result establishes internal consistency, not source truth, independently verified identity, or external attestation. See [observation architecture](docs/OBSERVATION_ARCHITECTURE.md) for the trust boundaries.
