# Accounts and workspace access

octolab uses Supabase Auth for browser identity and PostgreSQL for workspace ownership. The backend verifies identities with Supabase Auth, checks live Auth session/user records, and reads workspace membership on every request. User-editable metadata never grants membership or administrator access.

The public landing page stays public. The account interface supports email/password signup, email confirmation, sign-in, password reset/recovery, session persistence, workspace creation/selection, and sign-out. Signup and recovery preserve the chosen user, company, or administration area. Password requests go directly to the configured Supabase Auth origin; octolab never stores passwords. The pinned browser SDK uses PKCE and manages session refresh/storage. See [the three role journeys](ROLE_JOURNEYS.md) for entry points, company registration, and administrator review.

## Configuration

Set runtime settings in ignored .env or deployment secrets:

| Setting                  | Purpose                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| STORAGE_BACKEND=postgres | Explicitly selects PostgreSQL and Supabase account authentication.                                  |
| DATABASE_URL             | Server-only direct/session-pooler connection; never a browser variable.                             |
| LEGACY_WORKSPACE_ID      | SQLite identity printed by db:inspect. It does not grant anyone access.                             |
| SUPABASE_URL             | Hosted project's HTTPS API origin.                                                                  |
| SUPABASE_PUBLISHABLE_KEY | Public sb_publishable_… Auth key. Secret/service-role keys are rejected.                            |
| LEGACY_OWNER_USER_ID     | Explicit intended Supabase user UUID for the SQLite import.                                         |
| SUPABASE_ADMIN_USER_IDS  | Optional comma-separated platform operator UUID allowlist. Blank grants no platform administrators. |

VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are supported public aliases. The frontend receives validated public settings from /api/auth/config; private credentials are never embedded into its build.

No dashboard password, personal access token, legacy JWT signing secret, or service-role key is needed. The connected management plugin and the application's runtime database connection serve different purposes.

Use the same Supabase project for Auth and PostgreSQL. The backend database account must read Auth session/user records and private membership metadata and assume the private runtime role. Business queries use that non-login, non-bypass role with forced workspace RLS. An unexpectedly privileged/inheriting runtime role is rejected.

In Supabase Auth, enable email/password sign-in and email confirmation. Set the Site URL and allow only actual development/production callback URLs at the app origin. The callback uses /?auth_callback=1 with #dashboard, #company, or #admin to preserve the intended area. Configure production email delivery before relying on confirmations or password resets for customers. SMTP secrets stay outside frontend configuration.

## Initial migration and account bootstrap

1. Follow [PostgreSQL migration](POSTGRES_MIGRATION.md) through source inspection and schema migration. Preserve the SQLite source/backup.
2. Fill public Auth settings, database URL, and inspected legacy workspace ID. Start the PostgreSQL app. Signup can run before importing history; historical records are not claimed or exposed.
3. Create and confirm the intended owner's account. Copy its UUID from Supabase Auth's user list, or resolve that specific verified account through connected management tools. You may stop at the empty-workspace screen; creating another workspace is optional before import.
4. Stop the PostgreSQL runtime. Set LEGACY_OWNER_USER_ID explicitly, then run db:import and db:verify. Runtime ownership prevents import/recovery from overlapping an active server.
5. Restart. The assigned owner can select the imported workspace. Other signups receive only workspaces they explicitly create or are separately granted membership in.

The source is never edited by the importer. Consent events, content, key hashes, balances, and receipts remain intact. A fresh workspace created before import stays separate; the importer does not merge it into history.

## Roles and machine access

| Principal              | Allowed access                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace owner        | Own research, routing settings, API-key management, and test-funding controls.                                                                                                                                         |
| Workspace member       | Research/tool operations and usage reads; no key management, funding controls, or owner settings.                                                                                                                      |
| Platform administrator | Explicit operator access across registered workspaces, company ownership/access review, controlled diagnostics, manual approval/evaluation, dispute review, and audited workspace tool allowances.                     |
| Tool company owner     | Own registration, feedback, team grants/revocation, and access history; approved, separately released aggregate metrics for the assigned provider. Company membership grants no customer workspace or operator access. |
| Company analyst        | Company profile and approved aggregate insights only; no registration edits, team management, access history, or provider-lab access.                                                                                  |
| Scoped API key         | Explicit route/scope/tool allowlist for its owning workspace, within spend/expiry/revocation checks.                                                                                                                   |

Platform roles come from the server UUID allowlist. Workspace and company roles come from their separate membership tables. There is no first-signup administrator rule or editable JWT metadata shortcut. User previews remove admin privileges while retaining actual workspace memberships. Company previews require an explicit registered-company or integrated-provider target and restrict requests to that target; they create no permanent membership. Authorization normalizes URL casing, trailing slashes, and encoded parameters to match Express routing.

User workspace creation, company registration, and platform administration are separate flows. A company owner or administrator can enter their area without creating a customer workspace. Company owners can grant analyst access to existing confirmed accounts and revoke it in Company team. Emailed invitations, workspace membership editing, and OAuth/SSO setup remain separate work. Administrator MFA enrollment/verification is available in Settings; privileged requests require a live verified MFA session. See [administrator settings](ADMIN_TOOL_SETTINGS.md). Trusted operators can manage workspace memberships; removal or role changes take effect on the next backend request.

In PostgreSQL account mode, API_TOKEN and ADMIN_API_TOKEN do not replace account authentication. They retain their previous behavior only in explicit SQLite/local mode. For Claude, Codex, and other MCP hosts, issue a scoped workspace key and configure APILAYER_API_KEY. The consumer's conversation stays in its MCP host; it does not visit the dashboard or approve backend research spending.

Signing out ends the current browser session. Machine keys remain separate workspace credentials until revoked, expired, or capped. Admitted calls still settle conservatively after revocation or interruption.

## Account API

| Method | Route                  | Behavior                                                                                                                                                         |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/auth/config`     | Public `{enabled:false}` in SQLite mode, or validated public Auth URL/key in account mode.                                                                       |
| GET    | `/api/auth/me`         | Authenticated account ID/email, accessible workspaces/roles, company memberships/roles, platform-admin status, MFA verification, and admin preview availability. |
| POST   | `/api/auth/workspaces` | Create a workspace with `{name, requestKey}` and owner membership. Requires a verified account, JSON, and same-origin writes.                                    |
| POST   | `/api/auth/companies`  | Register a tool company for ownership/integration review; no existing customer workspace is required.                                                            |
| GET    | `/api/public/catalog`  | Public tool descriptions, provider availability, and configured estimates; no private activity or credentials.                                                   |

Company team grant/revocation requests are idempotent by actor, company, and request key. A replay after revocation does not restore a previous grant. Successful aggregate report requests append access status/policy audit events without copying report payloads. See [company team contracts](ROLE_JOURNEYS.md#company-and-review-api).

Protected browser requests send `Authorization: Bearer <Supabase access token>` and `X-Octolab-Workspace: <workspace ID>`. Omitting the workspace header selects the first accessible workspace; an inaccessible requested ID returns `403`. `/api/auth/me`, workspace creation, company registration, company-owner routes, and the global company-review queue do not require an existing workspace. Company and admin routes verify account identity independently of customer workspace headers; see [their API reference](ROLE_JOURNEYS.md#company-and-review-api). Login, signup, confirmation, refresh, recovery, and sign-out use the browser Auth SDK directly.

Workspace names are 2–80 characters. Creation accepts a UUID request key and refuses a new workspace when the account already has ten memberships. An identical retry returns the saved workspace; changed names under the same key return `409`, and a removed membership cannot be recovered by replay. Account/database verification failures return `503`; ended, expired, or invalid sessions return `401`.

## Session, audit, and payment boundaries

Verified identity lookups are briefly cached by token hash; live session/user status and membership are checked freshly. Logout/session deletion, account deletion/bans, expiry, and lost membership block subsequent requests. Verification/database outages fail closed without treating an Auth outage as an invalid password.

The frontend clears protected state on sign-out and rejected sessions. Account/workspace changes remount private views; request generations reject late responses from the previous workspace. Key-policy events record the authenticated account UUID. Observation events identify the requesting account/key separately from agent-reported model/host/reason fields.

Dispute review requires a configured platform administrator and records that account UUID. Signed Stripe webhooks remain independent of browser auth: signature verification precedes workspace resolution. External receipt/event identities remain globally unique; conflicting ownership stops processing. Existing test-credit holds remain retained.

Provider credentials stay server-side. Test credits do not authorize live provider spending. Stripe and Base Sepolia deposits stay disabled until explicitly configured. This checkpoint enables neither real-money payments nor production funding enforcement.

## Validation and deployment

Normal tests cover Auth-server verification and local compatibility. Disposable PostgreSQL tests cover ownership, role/path variants, membership/session revocation, scoped keys, multi-workspace signed webhooks, and admin attribution. Browser fixtures exercise SDK flows with synthetic Auth responses; they do not deliver email or validate hosted login.

Run only against a disposable fixture database:

```sh
OCTOLAB_TEST_POSTGRES_URL=postgresql://... npm test -- tests/accounts.test.ts tests/postgres.test.ts
```

These fixtures create a minimal synthetic Auth schema. Never point them at production Supabase.

The combined allowance, admin-navigation, and company-dashboard checkpoint passed 309 normal tests with 34 conditional skips, 41 fresh disposable PostgreSQL cases, and 197 desktop/mobile browser cases with one intentional skip. These totals cover the combined integration, not Auth alone. Fixture results remain separate from hosted-account checks, provider performance, and payments.

Separately from fixture testing, the connected Supabase project has all eight checked-in schema migrations installed with matching application checksums. The actual session-pooler database connection succeeds with certificate and hostname verification. A confirmed account is explicitly assigned as the imported workspace owner; its requested platform-admin allowlist entry is configured separately. Historical SQLite data has passed import and content verification. The canonical account runtime uses port 3008; see the [hosted rollout checkpoint](SUPABASE_ROLLOUT.md).

Before public launch, check recovery/login/logout, imported-workspace access, and role transitions against the hosted project. The confirmed account establishes confirmation for that account; it does not establish production SMTP delivery or complete end-to-end recovery coverage. The operator-controlled workspace allowance is active and defaults to denial without a grant; customer-issued keys and test-credit balances cannot raise it. See [allowance administration](WORKSPACE_ALLOWANCES.md). Fixture tests themselves made no hosted writes, provider calls, or payments.
