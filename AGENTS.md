# Project instructions

- The product's visible brand is **octolab**, using `public/octolab.svg`. Existing `apilayer` MCP registrations and technical identifiers remain compatible.
- APILayer is a general-purpose tool router for free-flowing use in Claude, Codex, and other MCP hosts. Users determine the task; do not frame the product as a predetermined company-research or shopping workflow.
- The research conversation and planning belong to the external agent (Claude, Codex, or another MCP host). APILayer supplies tools and observes intent, explicit tool choices, evidence, delivered output, and evaluations.
- APILayer is backend infrastructure in the consumer's conversation. Record intent internally and continue researching automatically under server-managed authorization and spending policy. Never ask consumers to approve APILayer sessions, choose research budgets, or visit the operator dashboard. A shopping budget is a product constraint, separate from backend spending policy.
- Keep observed events, agent-reported explanations, and operator evaluations distinct. Never invent private reasoning, measured quality, verified model identity, insurance coverage, refunds, or paid-provider results.
- Use shadcn components where available; adapt them lightly when necessary. Use Geist, a dark grayscale theme with no blue or colored accents, subtle pane shading, sentence case, and no eyebrow text.
- Always source interface icons from Untitled UI (`@untitledui/icons`). The shadcn generator may emit another icon package; replace those imports before keeping a generated component.
- When making Figma frames as iterations, never create frame captions; only name the frame.
- Keep provider credentials server-side. Commercial sharing starts off and stays separate from local recording.
- Preserve earlier research under `/research/`. Test fixtures must not enter the production workspace or provider/model statistics.
- Run `npm run check` and browser tests appropriate to changed behavior. Live provider checks require a bounded backend-authorized or operator-accepted session budget and must be reported separately from fixtures.
