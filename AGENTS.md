# Project instructions

- The research conversation and planning belong to the external agent (Claude, Codex, or another MCP host). APILayer supplies tools and observes intent, explicit tool choices, evidence, delivered output, and evaluations.
- Keep observed events, agent-reported explanations, and operator evaluations distinct. Never invent private reasoning, measured quality, verified model identity, insurance coverage, refunds, or paid-provider results.
- Use shadcn components where available; adapt them lightly when necessary. Use Geist, a dark grayscale theme with no blue or colored accents, subtle pane shading, sentence case, and no eyebrow text.
- Always source interface icons from Untitled UI (`@untitledui/icons`). The shadcn generator may emit another icon package; replace those imports before keeping a generated component.
- When making Figma frames as iterations, never create frame captions; only name the frame.
- Keep provider credentials server-side. Commercial sharing starts off and stays separate from local recording.
- Preserve earlier research under `/research/`. Test fixtures must not enter the production workspace or provider/model statistics.
- Run `npm run check` and browser tests appropriate to changed behavior. Live provider checks require a bounded accepted session budget and must be reported separately from fixtures.
