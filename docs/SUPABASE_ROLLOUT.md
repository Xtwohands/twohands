# Supabase rollout checkpoint

Status on 2026-11-08:

- Four checked-in schema migrations were applied to the connected Supabase project through MCP. The application migration ledger was updated in the same transactions, preserving compatibility with the local db:migrate checksum checker.
- The octolab schema has 28 tables with RLS enabled. The runtime role has neither superuser, bypass-RLS, nor login privileges.
- JSON helper functions use a fixed pg_catalog search path. Supabase's security advisor reports no warnings or errors for this schema.
- Six informational "RLS enabled, no policy" notices remain for private backend metadata/migration tables. This is intentional deny-by-default access; browser/runtime roles receive no policies for those tables. See the [advisor reference](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy). Do not add broad policies to silence these notices.
- The original ignored .env now contains the connected project's public Auth URL/key, their supported aliases, and the existing local workspace identity. Values are not copied into this repository.
- No application records have been imported to Supabase. The existing SQLite source remains authoritative. Runtime storage selection has not switched.

Remaining cutover inputs/actions:

1. Supply DATABASE_URL for the app's direct/session-pooler connection. MCP management access does not supply that private runtime credential.
2. Start the PostgreSQL account UI, confirm the intended owner's account, and explicitly configure LEGACY_OWNER_USER_ID.
3. Stop the runtime, run db:import and db:verify against the original SQLite source, then restart and verify historical balances/audit chains.
4. Verify actual hosted email confirmation, recovery, login, and logout. Configure the platform-admin UUID allowlist if operator access is needed.

Use the original checkout's SQLite path when importing. From an isolated worktree, set DB_PATH to the absolute original database file rather than the worktree's default relative path.

Local validation remains separate from hosted rollout: 267 normal tests, 16 disposable PostgreSQL cases, and 153 desktop/mobile browser cases passed; one desktop navigation case was intentionally skipped. No live provider requests, payments, transfers, or deposit enablement occurred.
