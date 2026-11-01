# Observation architecture

APILayer is a local observation and evaluation layer. Claude, Codex, or another MCP host owns the conversation and chooses tools. The browser accepts intent and budgets, inspects evidence, and reviews outcomes.

```mermaid
flowchart LR
  User[User] --> Host[Claude / Codex / MCP host]
  User --> UI[Observation dashboard]
  Host <-->|Narrow tool catalog| Bridge[Stdio MCP bridge]
  Bridge <-->|Loopback HTTP| API[APILayer API]
  UI <-->|Operator API| API
  API --> DB[(SQLite records)]
  API <-->|Explicit selected call| Providers[Exa / Tavily / Firecrawl]
```

The bridge never opens the database. A single HTTP process owns SQLite and provider admission. Existing research remains under `/research/`, with its earlier deterministic routing clearly separated from external-agent decisions.

## Record lifecycle

1. An operator or agent records an objective, distinct weighted criteria, constraints, estimated budget cap, and optional reported model/host. The objective, criterion IDs/text/weights, constraints, and budget are hashed together.
2. An operator accepts that exact hash. MCP cannot approve it. Approval is idempotent; a mismatched hash is rejected.
3. Discovery records the options returned at that moment, including configured prices and local performance samples. It does not select a tool or establish which options the agent considered.
4. The agent explicitly invokes a named provider. A transaction checks approval, configuration, rate/call limits, and remaining estimated budget; it records a request key and reserves the estimate before network I/O.
5. The settled call records timing, API status, page status where available, returned evidence, and the configured estimate. An optional selection explanation is a separate agent-reported event.
6. The agent submits its actual final output and supporting call IDs. Outputs are versioned and linked to the accepted intent. Submission does not verify success.
7. An operator evaluates every criterion as pass, fail, or unknown, with a note and optional evidence references. Each evaluation binds an exact output ID and intent hash. A historical review requires explicit intent and never replaces the latest output's score.
8. A review case can reference any recorded evaluation. Opening/resolving a case records evidence and a decision, without issuing a refund, payment, or insurance coverage.

The state label is a workflow convenience: awaiting approval, active, completed, or evaluated. A later call can reopen activity; a new submitted version requires its own evaluation. Prior versions and reviews remain available.

## Retry and recovery semantics

Provider request keys are unique within a session. The signature covers tool, normalized arguments, and supplied explanation. Identical replays return the existing receipt; changed arguments with the same key fail. An in-flight replay returns a running receipt rather than another provider request. A new operation needs a new key.

Output submissions have independent idempotency keys. A replay returns the original output version even after a newer version was submitted. Evaluation and case writes append records and do not currently expose client idempotency keys; clients should refresh after an uncertain response before submitting again.

On an unclean process termination, startup marks outstanding calls interrupted and conservatively consumes their reserved estimates once. It does not assume the vendor failed or silently repeat a potentially billed operation. A cached evidence read never invokes a provider.

## Evaluation semantics

- Score = passed weight / known weight. Failed criteria count as known; unknown criteria do not count as a pass or failure.
- Coverage = known weight / total accepted weight. A 100% score at 50% coverage is not full fulfillment.
- An all-unknown review has a null score and zero coverage.
- Model summaries use the latest evaluation of the latest output per session. They require at least five fully reviewed sessions before displaying a local aggregate score, and never score the `Not reported` model group.
- These are task-specific workspace reviews, not a general model benchmark. Reviewer kind and model identity are reported, not authenticated or independently attested. Assistant-written reviews are visibly labeled.
- Provider quality remains unknown. Local HTTP success and latency are execution measurements, not accuracy or task success.

## API surface

All routes below live under `/api/observations`, inherit workspace token/origin/host checks, and use a 160 KB JSON request limit.

| Route                                        | Behavior                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /`                                      | Session list with output/evaluation metadata, without full output text or review notes |
| `POST /` / `POST /proposals`                 | Operator-entered / agent-reported intent                                               |
| `GET /summary`, `/catalog`, `/aggregate`     | Local summaries, tools, and consented cohort statistics                                |
| `GET/POST /connection`                       | Last-observed client name/version; not a live heartbeat                                |
| `GET /:id`                                   | Private session, evidence, events, and chain consistency                               |
| `POST /:id/approve`                          | Accept exact intent hash                                                               |
| `POST /:id/discover`                         | Record offered tool set                                                                |
| `POST /:id/call`                             | Execute explicit tool with request key                                                 |
| `GET /:id/calls/:callId`                     | Read a cached receipt scoped to this session                                           |
| `POST /:id/outcome`                          | Versioned output submission                                                            |
| `POST /:id/evaluate`                         | Criterion review; explicit `historical: true` for prior output                         |
| `POST /:id/cases`, `POST /:id/cases/:caseId` | Open and resolve/dismiss a review case                                                 |
| `POST /:id/consent`                          | Change optional commercial aggregate consent                                           |
| `GET /:id/export`                            | Content-minimized summary export                                                       |
| `POST /:id/delete`                           | Delete local records after confirming the session ID; blocked during active calls      |

Schemas and validation live in `server/observation.ts`; protocol tool definitions in `server/mcp-server.ts`. [MCP setup](MCP.md) describes the agent-facing subset.

## Offline evidence verification

`npm run verify:evidence -- /path/to/private-evidence.json` checks a private export without contacting the API or any provider. It recomputes the accepted-intent fingerprint and event chain, compares materialized source/output/review content against recorded events, checks evidence and case references, reconciles the estimated ledger, and compares the current consent flag with its last event. A summary export intentionally omits the necessary private content and cannot pass this check.

Exit codes are 0 for consistent records, 1 for inconsistencies, and 2 for an unreadable/invalid JSON input. The report contains identifiers and error descriptions, not the research text. Informational timestamps and display labels are not externally authenticated. An export of unfinished work can be internally consistent; passing does not mean the task succeeded or the source claims are true.

## Boundaries and next steps

MCP does not expose private reasoning, the host's complete conversation, or outside tool calls. APILayer records only what reaches its own tools. The local event chain detects chain inconsistency but is not external custody or protection against a database owner rewriting the whole record. Provider content is untrusted, extraction text may be partial, and model/client/reviewer identities are reported.

Before a commercial scoring or refund product: add authenticated principal identities, external evidence attestation, a reproducible evaluation protocol with independent review, verified price/usage reconciliation, and a separately defined claims/payment contract. Before vendor analytics: define consent and licensing for every exported field, cohort and privacy protections, and a buyer-facing export boundary. Those are future product capabilities, not claims made by this implementation.
