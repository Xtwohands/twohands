# PostgreSQL migration and account cutover

The production path is PostgreSQL on Supabase. SQLite remains the default until an explicit cutover; fixtures continue to use isolated SQLite databases. Adding `DATABASE_URL` alone does not migrate or switch the app. The earlier storage-only checkpoint retained owner/admin tokens. The current checkpoint adds [Supabase Auth and workspace authorization](AUTH.md): PostgreSQL requires account sessions or scoped workspace keys and ignores `API_TOKEN`/`ADMIN_API_TOKEN`. SQLite retains its local token mode.

The connected project has all four checked-in schema migrations applied with matching checksums, including the JSON helper search-path migration. This is schema preparation only: runtime storage still uses SQLite and no application records have been imported. Follow the [hosted rollout checkpoint](SUPABASE_ROLLOUT.md) for the remaining private connection, account, import, and verification steps.

## What changes

All domain database operations are asynchronous. PostgreSQL uses a bounded connection pool with certificate verification. Use a direct connection or the Supabase **session pooler on port 5432**. Transaction pooling is unsupported because runtime ownership uses a session advisory lock.

Application tables live in the private `octolab` schema, outside Supabase's public Data API. Browser roles receive no grants. Each business table has a workspace column, tenant indexes, and forced row-level security. Each backend transaction sets a local, non-login, non-bypass role and workspace context; both reset when the transaction finishes. Tenant IDs never come from provider results. Primary keys and foreign keys include workspace identity. External payment proofs, Stripe payment identities, and webhook event IDs remain globally unique.

Short workspace transactions serialize reservation, receipt, policy, and ledger changes across connections. Network provider calls occur outside those transactions. Audit hash appends join an existing transaction or acquire one. Concurrent retries re-read receipts after admission locking. Legacy task writes reject changed snapshots instead of overwriting another operation.

The runtime still supports **one API server per database**. Its advisory ownership lock prevents another instance from running restart recovery over live calls. Losing the lock connection terminates the server so another process cannot recover its work while it continues serving. Horizontal worker leases are future work; a pooled database alone does not make the application horizontally deployable.

Existing evidence JSON is preserved as text to retain hashes and historical semantics. Workspace/order indexes support current queries; the current dashboard still aggregates some history in application memory. This checkpoint does not claim an analytics warehouse, evidence object-storage migration, or unlimited-scale dashboard queries.

## Prepare the cutover

1. Keep `STORAGE_BACKEND=sqlite` while preparing. Configure the private `DATABASE_URL` in ignored `.env` or deployment secrets. Never use a `VITE_` variable for it.
2. Stop the existing API server and maintenance processes. SQLite's exclusive lock makes an active workspace export fail safely. Retain a backup of the SQLite database and its WAL state before deployment; do not copy only the main file while a writer is running.
3. Run `npm run db:inspect`. It opens the source read-only and prints workspace identity, counts, and snapshot digest. Set `LEGACY_WORKSPACE_ID` to that identity.
4. Run `npm run db:migrate`. Checked-in SQL migrations run atomically with checksum tracking. Editing an applied migration is rejected. Include the authenticated-workspace migration; do not stop at the earlier storage-only schema.
5. Configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or their `VITE_` public aliases) for the same project as the database. Start with `STORAGE_BACKEND=postgres` to create and confirm the intended owner account, following [account bootstrap](AUTH.md#initial-migration-and-account-bootstrap). No imported history is exposed or assigned by signup. An empty new workspace is optional and stays separate from history.
6. Stop the PostgreSQL runtime, set `LEGACY_OWNER_USER_ID` to that specific account's actual Supabase Auth UUID, then run `npm run db:import`. No service-role key, personal access token, or dashboard password is required. All copied tables, original event IDs, insertion order, key hashes, ledgers, receipts, consent events, and provider fixtures already present in that source stay in the same legacy workspace. The source is never edited. Fixture databases must never be chosen as production input.
7. Run `npm run db:verify` before restarting. Counts and canonical per-column content digests must match. Identical imports are repeatable; a different source snapshot or occupied destination is rejected. Imports and verification refuse to run against an active PostgreSQL server.
8. Build and restart with `STORAGE_BACKEND=postgres`. Sign in as the assigned owner and select the imported workspace. Check `/healthz`, owner/member separation, historical audit integrity, and existing receipt balances before allowing new work. Configure `SUPABASE_ADMIN_USER_IDS` only for intended platform operators; owners do not automatically become platform administrators.

The importer is all-or-nothing and never merges into an occupied tenant or reassigns a tenant with another member. Original JSON values remain byte-for-byte identical. PostgreSQL numeric driver representation is normalized only when comparing per-column digests.

## Rollback

Before the first PostgreSQL write, stop the new runtime and select the preserved SQLite source with `STORAGE_BACKEND=sqlite`. After new PostgreSQL writes, reverting to the old SQLite file would lose new receipts and accounting changes. Keep PostgreSQL stopped and reconcile or export those changes before selecting another storage backend. No automatic reverse migration or destructive reset is included.

Retention targets the configured legacy workspace and requires the runtime to be stopped. Additional tenant retention scheduling belongs with account-aware operational jobs.

## Validation

`npm run check` runs the existing isolated suite. To run real PostgreSQL integration tests, provide **a disposable database**, never the production URL:

```sh
OCTOLAB_TEST_POSTGRES_URL=postgresql://... npm test -- tests/postgres.test.ts tests/accounts.test.ts
```

These tests create fixture workspaces and a minimal synthetic Auth schema in that database. They must never target hosted production Supabase. Account coverage includes live session/membership revocation, owner/admin separation, scoped workspace keys, signed cross-workspace webhook resolution, and audit attribution. Hosted schema installation was completed separately through MCP and is recorded in the [rollout checkpoint](SUPABASE_ROLLOUT.md); hosted login, email delivery, and application-data cutover remain unperformed. They exercise migration checksums, tenant separation, global payment-proof uniqueness, receipt retries, concurrent caps, atomic audit chains, Stripe test-ledger/dispute flows, and verified SQLite import/replay. No live provider or payment request is made. Browser fixtures remain separate from production data.
