# User, admin, and tool company journeys

PostgreSQL account mode separates three areas. One account can have more than one authorized area; moving between areas does not grant permissions. Company ownership is independent of customer workspace membership. Platform administration comes only from the server's explicit UUID allowlist.

| Person             | Entry and sidebar                                                                                               | First task                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| User               | `#dashboard`: tools, routing, activity, usage, connections; owners also see credits and API keys                | Create/select a workspace, create a scoped API key, then connect an external agent                                      |
| Tool company owner | `#company`: company overview, integration status, tool insights, and owner-only team management                 | Register the company and tool for ownership/integration review; no customer workspace is required                       |
| Platform admin     | `#admin`: company reviews, then workspace operations, disputes, and provider lab when customer workspaces exist | Review company ownership and grant or suspend access; no customer workspace is required to use the company-review queue |

Users keep the conversation and tool choices in Claude, Codex, or another MCP host. The dashboard configures and inspects that infrastructure. It does not turn each consumer task into an operator approval flow.

## Register and review a tool company

1. Open **For tool companies** on the public site, then sign in or create and confirm an account. Confirmation and recovery return to the company area.
2. Submit company name, HTTPS website, tool name, and description. The registration starts **Under review** (`pending`). It neither claims an existing provider nor exposes its data.
3. A platform admin opens **Company reviews**, checks the applicant and ownership evidence, selects the verified existing integration, and records feedback. Approval requires a provider binding. Only one approved company can own each integrated provider.
4. If the admin requests changes (`rejected`), the owner uses **Update registration**, edits the details, and resubmits. This creates a new audited revision and returns the registration to `pending`. Stale edits return `409`.
5. Approval and aggregate-insight release are separate administrator decisions. Suspending the company immediately blocks subsequent insight requests. An owner cannot lift suspension or edit an approved integration into a different provider.

The portal supports one owner per company registration, up to five registrations per account, and the existing Exa, Tavily, and Firecrawl integrations. Owners can add analysts to their company; arbitrary connector installation and emailed invitations remain separate work. Registration does not accept provider credentials or execute supplied endpoints/code.

## Manage company team access

Open **Company team** in the company sidebar. The owner can add an analyst by the email of an existing, confirmed octolab account, then remove that access when needed. A company can have at most 20 members including its owner. The owner cannot be removed or transferred through this screen.

Analysts can read their company's profile and approved aggregate insights. They cannot change a registration, manage team members, read access history, or approve an integration. Membership is checked on subsequent requests, so removal blocks further company reads. Replaying an earlier grant after revocation does not restore access; a deliberate new grant requires a new request key.

The owner-only **Access history** records recent analyst grants, revocations, and aggregate-report access, including when a report was withheld for release or cohort requirements. Platform admins can inspect/manage company teams under their explicit permissions. No customer workspace access is granted by a company membership.

## Switch areas and preview permissions

**Settings** holds links to the account's user and company areas. Administrators also have **Preview as** options for the user and tool-company experiences, with a visible **Return to admin** control. Preview uses real account data and keeps actual workspace/company memberships; it removes administrator privileges instead of impersonating another person or granting sample access. A preview with no memberships therefore shows the corresponding onboarding flow.

## Read company insights

An approved company owner or analyst sees metrics only for the provider bound by an administrator. The backend checks current membership and company status on each request; customer workspace headers cannot change that binding. Company members cannot read another company's record, customer prompts/results, private exports, or the operator lab.

Reports have four allowlisted counts: eligible offered sessions, sessions using the tool, completed calls, and successful calls. Eligibility follows discovery matches, and counted execution must follow the eligible offer. These are observed session-level counts, not proof that a model considered an option, an exact candidate attribution, an explanation for rejection, or a quality score.

After explicit insight release, metrics remain suppressed until the configured minimum cohort, at least five, includes independent workspaces offering and using the tool and enough selected sessions. Repeated calls from one workspace cannot unlock the report. Suppressed reports return `metrics: null`; no raw content, consumer identities, or session IDs are returned. No package is published or delivered automatically.

## Company and review API

All company routes require a verified Supabase account session. They do not require a customer workspace. Machine API keys and editable account metadata do not grant company/admin access. Writes require same-origin JSON. Administrator previews send `X-Octolab-Preview: user` or `company`; the backend verifies the admin identity and removes its elevated privileges for that request. Non-admin preview attempts receive `403`.

| Method | Route                                 | Contract                                                                                                                             |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/auth/companies`                 | `{name, website, toolName, description, requestKey}` creates an idempotent owner registration                                        |
| GET    | `/api/companies/:id`                  | Company-member or platform-admin record; unrelated accounts receive `404`                                                            |
| POST   | `/api/companies/:id/resubmit`         | Owner-only revisioned edit of `pending`/`rejected` registrations; same details plus `revision`, without `requestKey`                 |
| GET    | `/api/companies/:id/insights`         | Approved company report with `available`, `awaiting_release`, or `insufficient_data` status                                          |
| GET    | `/api/companies/:id/members`          | Owner/admin-only company team list                                                                                                   |
| POST   | `/api/companies/:id/members`          | Owner/admin-only `{action:"grant", email, requestKey}` or `{action:"revoke", userId, requestKey}`                                    |
| GET    | `/api/companies/:id/access-history`   | Owner/admin-only latest 100 membership-change and report-access events                                                               |
| GET    | `/api/admin/companies?status=pending` | Admin queue, server-filtered by `pending`, `approved`, `rejected`, `suspended`, or `all`; up to 100 items and an opaque `nextCursor` |
| POST   | `/api/admin/companies/:id/review`     | `{revision, status, providerId, insightsEnabled, feedback}` records approval, requested changes, or suspension                       |
| GET    | `/api/admin/companies/:id/history`    | Admin-only registration, resubmission, and review history with actor, time, revision, and decision data                              |

Pass `cursor=<nextCursor>` with the same status to continue the queue. Review writes require the current revision, so a stale review cannot overwrite a newer decision. Company fields are bounded: name/tool name 2–80 characters, website at most 300 characters, description 20–1,500 characters; review feedback is 5–1,500 characters.

The public `GET /api/public/catalog` returns tool descriptions, availability, and configured estimates without private activity. The previous `/api/company-insights/:provider` remains an administrator-only operator preview in PostgreSQL mode, separate from this company-membership-scoped API. SQLite/local mode preserves its existing demo and workspace-token behavior.

See [account configuration](AUTH.md), [provider lab](PROVIDER_LAB.md), and [current hosted rollout status](SUPABASE_ROLLOUT.md).
