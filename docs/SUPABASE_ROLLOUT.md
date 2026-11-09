# Supabase rollout checkpoint

Status on 2026-11-08:

- Five checked-in schema migrations are installed in the connected Supabase project. The application migration ledger matches, and `db:migrate` verified all five checksums through the actual application database connection.
- The session pooler on port 5432 connects successfully with certificate and hostname verification using Supabase's public root CA. The direct IPv6 endpoint refused TCP connections. Runtime credentials stay in the original ignored `.env`, alongside public Auth settings and the existing local workspace identity.
- Workspace business tables use forced workspace RLS and a runtime role without superuser, bypass-RLS, or login privileges. Private company-registration/review tables also have RLS and no browser or workspace-runtime grants.
- JSON helper functions use a fixed `pg_catalog` search path. The earlier four-migration security-advisor pass reported no warnings/errors and six informational “RLS enabled, no policy” notices for intentionally private metadata. See the [advisor reference](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy); the company migration adds the same deny-by-default metadata pattern.
- A confirmed hosted account exists. Its explicitly requested platform-admin UUID allowlist entry is configured locally; no email address or account UUID is stored in these docs. An account runtime starts at `http://127.0.0.1:3008/#dashboard`, with the [separate role journeys](ROLE_JOURNEYS.md).
- Health returns 200, public Auth configuration is enabled for the intended project, and private endpoints return 401 without a session. Browser checks render account controls without page errors. These checks do not establish complete hosted recovery/login/logout coverage.
- No historical application records have been imported. The original SQLite source remains authoritative and the original runtime still defaults to SQLite. New account/workspace records are separate from imported history. Deposits remain disabled.

Remaining cutover actions:

1. Explicitly configure `LEGACY_OWNER_USER_ID` for the confirmed intended owner. Administrator access alone does not assign ownership of imported history.
2. Stop runtimes, preserve a consistent SQLite backup, and run `db:import` and `db:verify` against the original SQLite source.
3. Restart the intended primary runtime with PostgreSQL and verify historical balances, receipts, audit chains, workspace access, and role boundaries.
4. Complete actual hosted recovery/login/logout and redirect checks; establish production email-delivery behavior before public use.

Use the original checkout's SQLite path when importing. From an isolated worktree, set `DB_PATH` to the absolute original database file rather than the worktree's default relative path. Worktree consolidation and the remaining data-focused backlog are not completed by this checkpoint.

Local fixture validation: 267 normal tests and 18 disposable PostgreSQL cases passed. The full desktop/mobile browser pass recorded 159 passes and one intentional skip before final review corrections; all 14 focused account/role browser cases passed after those corrections. No live provider requests, payments, transfers, or deposit enablement occurred in this checkpoint.
