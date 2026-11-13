# Seller reports

The **Agent choices** section of the company area shows a tool company where agents chose its tool, where they chose another, and the reasons they gave. It is built only from recorded sessions.

## What agents now report

| Field         | Where                         | Meaning                                                    |
| ------------- | ----------------------------- | ---------------------------------------------------------- |
| `taskType`    | `record_intent`               | Closest category for the task. Defaults to `other`         |
| `reasonTheme` | each named provider tool call | Optional single theme for the stated reason for that call  |

Both come from fixed lists in `server/seller-taxonomy.ts` and are agent-reported, never observed. They exist so reports can group activity without exposing objectives or stated reasons. Sessions and calls recorded earlier have neither and appear as "Other" and "No theme given".

## The report

`GET /api/company-insights/:provider/choices?days=7|30|90&named=0|1`, computed in `server/seller-report.ts`. A task is one session.

- **Funnel**: eligible, chosen by the agent, call succeeded, cited in the answer.
- **By task type**: for eligible tasks, how many chose this tool, another tool of the same kind, or neither.
- **Reasons**: themes from the first call to this tool, and from the first call to the tool chosen instead.
- **Demand not served**: requests of this kind where the tool was ruled out before the agent chose, by cause.
- **Failures**: failed calls by kind, and what the agent did next.
- **Price**: average estimate shown, average cost the provider reported, tasks ruled out on budget, tasks lost with cost as the reason.
- **Used alongside** and **by which agents**.

## Rules the report keeps

- Aggregates only. No objective, query, URL, stated reason, answer, title, model name or session ID.
- "Chosen" is the agent's own choice. Calls octolab routed are counted separately and never as a choice.
- A share needs at least 30 tasks (`SELLER_MIN_SAMPLE`). Counts are always shown.
- With `named=0`, other companies are grouped as "Other search tools" or "Other page tools". With `named=1` they are named.
- Reasons and task types are what agents reported.

## Not built yet

- The named-comparison choice is a request parameter and a switch in the view. It is not stored per company, and there is no rule yet that a company must agree to be seen before it sees others.
- The endpoint is the operator-restricted preview path. The company-member API (`/api/companies/:id/insights`) still returns the original four counts.
- No billing for companies.

## Simulated data

```bash
npm run simulate:sellers -- 400 ./data/simulation.sqlite --reset
```

`scripts/simulate-seller-data.ts` seeds a separate database with invented agent sessions. It uses the real session, discovery, call, routing and outcome code with fake providers and scripted choices, makes no network calls, and refuses to write to the working database. The database is marked as simulated and every report built from it carries that notice. Timings are not realistic. Start the server with `DB_PATH=./data/simulation.sqlite` to view it.

Simulated results show that the report works. They say nothing about any real provider or agent.
