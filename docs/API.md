# API contract

Base URL: `http://127.0.0.1:3001`. Requests that mutate state require `Content-Type: application/json`. If `API_TOKEN` is configured, every `/api/*` request requires `Authorization: Bearer <workspace token>`. Same-origin writes only. `/healthz` returns minimal unauthenticated liveness.

## Create explicit intent

`POST /api/tasks`

```json
{
  "prompt": "Find funded companies building agent payment products, with current activity and evidence links.",
  "query": "agent payments companies funding",
  "queries": [
    "agent payments companies funding",
    "agent payments startup product launch"
  ],
  "requiredCount": 20,
  "budgetMicros": 100000,
  "criteria": [
    "Currently operating",
    "External funding evidence",
    "Agent payments relevance"
  ],
  "domains": [],
  "mode": "route",
  "preference": "balanced",
  "consent": false
}
```

Returns `201` with a saved task ID and ready status. No paid operation occurs. `queries` is optional; otherwise `query` is the plan. Plans allow 1–5 queries, budget $0.001–$5, target 1–100, unique criteria 1–8, allowed domain hostnames 0–10. Task storage is limited to 500 local sessions.

## Execute research.search

`POST /api/tasks/:id/run` with `{}` executes the saved plan. `{ "query": "more specific follow-up" }` executes one follow-up query with the same task rubric, domain policy, mode, and remaining budget.

Returns `202` once accepted. Poll `GET /api/tasks/:id` for task state and append-only events. Repeated simultaneous operations for the same task return `409`. Missing keys, exhausted budget, and task safety caps also return actionable `409` errors. The global concurrency limit returns `429`.

`POST /api/tasks/:id/cancel` with `{}` requests stopping between calls. It does not refund or abort an in-flight vendor request. Returns whether a request to stop was registered.

## Execute research.fetch_url

`POST /api/tasks/:id/fetch`

```json
{ "sourceId": "<UUID of a returned source>" }
```

Requires configured Firecrawl credentials and enough remaining budget. The URL is resolved from the stored source, not accepted as arbitrary caller input. Extraction updates the stored excerpt and records a separate paid capability. It does not automatically verify funding or current activity.

## Review evidence

`POST /api/tasks/:id/assessments`

```json
{
  "sourceId": "<source UUID>",
  "organization": "Organization name",
  "criteria": {
    "Currently operating": "pass",
    "External funding evidence": "unknown",
    "Agent payments relevance": "pass"
  },
  "evidence": {
    "Currently operating": ["<product source UUID>"],
    "External funding evidence": ["<funding source UUID>"],
    "Agent payments relevance": ["<product source UUID>"]
  },
  "disposition": "pending",
  "note": "Current product page supports activity and relevance; the funding claim still needs proof."
}
```

The criteria must exactly match the saved rubric. Every evidence ID must belong to the task. If evidence mappings are omitted, the reviewed source is used by default. Allowed verdicts: pass/fail/unknown. Allowed dispositions: pending/accepted/rejected. Acceptance additionally requires an organization, every criterion passing, and a note. Updates replace the current source assessment and append a feedback event.

## Read and export

| Endpoint                     | Response                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /api/health`            | Provider key presence, configured estimates, policy/rate-card versions, minimum cohort; no credentials |
| `GET /api/tasks`             | Recent local task summaries                                                                            |
| `GET /api/tasks/:id`         | Internal task context, sources, current assessments, accepted organizations, full trace                |
| `GET /api/tasks/:id/results` | Human-reviewed organization shortlist and CSV string; contains workspace content                       |
| `GET /api/tasks/:id/export`  | Allowlisted JSON event summary without raw task/provider/reviewer content                              |
| `GET /api/analytics`         | Consented aggregate metrics, or explicit cohort suppression                                            |

The internal task endpoint is not a provider-facing feed. Use the sanitized export for sharing traces without content. Result CSVs intentionally include company names, evidence URLs, and reviewer notes; cells are escaped to prevent spreadsheet formula execution.

## Error behavior

Errors return `{ "error": "Actionable message" }`. Vendor errors expose only classified transport errors or HTTP status, never raw vendor bodies. Budget amounts in responses are estimates in integer USD micro-units, not proof of actual charges.
