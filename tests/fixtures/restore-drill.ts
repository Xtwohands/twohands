/** Disposable, local-only recovery fixture. Never imported by the production runtime. */
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { Store } from "../../server/store.js";
import { PostgresDatabase } from "../../server/database.js";
import { applyMigrations, claimRuntime } from "../../server/migration.js";
import { Observatory } from "../../server/observation.js";
import { FundingService } from "../../server/funding.js";
import { StripeFundingService } from "../../server/stripe-funding.js";
import { backupDatabase, restoreDatabase } from "../../server/backup.js";
import { config } from "../../server/config.js";
import { FixtureStripeGateway, fixtureStripeSettings } from "./stripe.js";

export async function runRestoreDrill(
  maintenanceUrl: string,
  outputDirectory?: string,
) {
  const parsed = new URL(maintenanceUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  )
    throw new Error(
      "The restore drill accepts an explicit loopback PostgreSQL maintenance connection only.",
    );
  const root =
    outputDirectory ??
    (await mkdtemp(join(tmpdir(), "octolab-restore-drill-")));
  const suffix = randomUUID().replaceAll("-", ""),
    sourceName = `octolab_drill_source_${suffix}`,
    targetName = `octolab_restore_${suffix}`;
  const sourceUrl = new URL(maintenanceUrl),
    targetUrl = new URL(maintenanceUrl);
  sourceUrl.pathname = `/${sourceName}`;
  targetUrl.pathname = `/${targetName}`;
  const admin = new pg.Pool({ connectionString: maintenanceUrl, max: 2 });
  const workspaces = [randomUUID(), randomUUID()],
    owner = randomUUID();
  const original = {
    keys: { ...config.keys },
    token: config.token,
    rpm: config.rpm,
    fetch: globalThis.fetch,
  };
  const created: string[] = [];
  let source: Store | undefined, restored: Store | undefined;
  const archive = join(root, "application-backup.enc"),
    tampered = join(root, "tampered-backup.enc"),
    passphrase = randomBytes(32).toString("base64url");
  const evidence = {
    version: "octolab-restore-drill-v1",
    source: "disposable fixtures only",
    completedAt: "",
    backupEncrypted: false,
    authenticatedBeforeRestore: false,
    wrongPassphraseRejected: false,
    corruptionRejected: false,
    populatedDestinationRejected: false,
    activeRuntimeRejected: false,
    rowDigestsMatch: false,
    auditChainsValid: false,
    financialBalancesMatch: false,
    workspaceIsolationPassed: false,
    sourceDatabaseDropped: false,
    restoredDatabaseDropped: false,
  };
  try {
    globalThis.fetch = async () => {
      throw new Error("External HTTP is disabled in the restore drill.");
    };
    config.keys.exa = "FIXTURE_ONLY";
    config.token = "fixture-owner-token-for-isolated-restore";
    config.rpm = 1000;
    for (const name of [sourceName, targetName]) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created.push(name);
    }
    source = new Store(":unused:", sourceUrl.toString(), workspaces[0]);
    const database = source.db as PostgresDatabase;
    await applyMigrations(database);
    await database.pool.query(
      "INSERT INTO octolab.workspaces(id,name) VALUES($1,'Restore fixture A'),($2,'Restore fixture B')",
      workspaces,
    );
    const obs = new Observatory(source, {
      search: async (_provider, _query, _domains, callId) => ({
        httpStatus: 200,
        sources: [
          {
            id: randomUUID(),
            title: "RESTORE_FIXTURE_RAW",
            url: "https://example.com/fixture",
            snippet: "Synthetic private evidence",
            provider: "exa",
            callId,
          },
        ],
      }),
      scrape: async () => ({ text: "fixture", httpStatus: 200 }),
    });
    await obs.ready;
    const balances: number[] = [];
    for (const [index, workspaceId] of workspaces.entries()) {
      await source.scope.run(workspaceId, () =>
        source!.actorScope.run({ kind: "account", id: owner }, async () => {
          await database.pool.query(
            "INSERT INTO octolab.workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
            [workspaceId, owner],
          );
          const { key } = await obs.db.apiKeys.create({
            requestKey: randomUUID(),
            name: "Restore fixture agent",
            scopes: ["research:write", "tools:execute"],
            allowedTools: ["exa_search"],
            limitUsd: "0.1",
          });
          const session = await obs.createAgentSession(
            {
              title: `Restore fixture ${index}`,
              objective: "RESTORE_FIXTURE_RAW evidence",
              criteria: [{ text: "Fixture evidence", weight: 1 }],
              constraints: "",
              model: "fixture",
              host: "restore-drill",
            },
            key.id,
          );
          await obs.execute(
            session.id,
            {
              tool: "exa_search",
              query: "RESTORE_FIXTURE_RAW query",
              statedReason: "Synthetic recovery fixture",
              requestKey: "fixture-call",
            },
            key.id,
          );
          const funding = new FundingService(source!, {
            enabled: false,
            recipient: "",
            rpcUrl: "https://fixture.invalid",
          });
          const gateway = new FixtureStripeGateway(),
            stripe = new StripeFundingService(
              funding,
              { ...fixtureStripeSettings },
              gateway,
            );
          const deposit = await stripe.create({
            requestKey: randomUUID(),
            amount: index ? "20" : "10",
          });
          gateway.pay(deposit.checkoutSessionId!, index ? 0 : 250);
          await stripe.reconcile(deposit.id);
          balances.push(await funding.ledger.balance());
        }),
      );
    }
    const release = await claimRuntime(database);
    try {
      await assert.rejects(
        backupDatabase(
          sourceUrl.toString(),
          join(root, "must-not-exist.enc"),
          passphrase,
        ),
        /source runtime or maintenance/,
      );
      evidence.activeRuntimeRejected = true;
    } finally {
      await release();
    }
    await source.close();
    source = undefined;
    const backup = await backupDatabase(
      sourceUrl.toString(),
      archive,
      passphrase,
    );
    const bytes = await readFile(archive);
    evidence.backupEncrypted =
      bytes.subarray(0, 12).toString().startsWith("OCTOLAB-BK1") &&
      !bytes.includes(Buffer.from("RESTORE_FIXTURE_RAW")) &&
      ((await stat(archive)).mode & 0o777) === 0o600;
    const untouched = new pg.Pool({ connectionString: targetUrl.toString() });
    try {
      await assert.rejects(
        restoreDatabase(
          targetUrl.toString(),
          archive,
          `${passphrase}-wrong`,
          targetName,
        ),
        /authentication failed/,
      );
      evidence.wrongPassphraseRejected = true;
      const changed = Buffer.from(bytes);
      changed[Math.floor(changed.length / 2)] ^= 1;
      await writeFile(tampered, changed, { mode: 0o600 });
      await assert.rejects(
        restoreDatabase(targetUrl.toString(), tampered, passphrase, targetName),
        /authentication failed/,
      );
      evidence.corruptionRejected = true;
      evidence.authenticatedBeforeRestore =
        (
          await untouched.query(
            "SELECT 1 FROM pg_namespace WHERE nspname='octolab'",
          )
        ).rowCount === 0;
    } finally {
      await untouched.end();
    }
    const recovery = await restoreDatabase(
      targetUrl.toString(),
      archive,
      passphrase,
      targetName,
    );
    evidence.rowDigestsMatch = recovery.verified;
    evidence.auditChainsValid =
      recovery.audit.valid &&
      recovery.audit.events > 0 &&
      recovery.audit.chains === 2 &&
      recovery.keyLedgerValid;
    await assert.rejects(
      restoreDatabase(targetUrl.toString(), archive, passphrase, targetName),
      /already contains octolab data/,
    );
    evidence.populatedDestinationRejected = true;
    restored = new Store(":unused:", targetUrl.toString(), workspaces[0]);
    const restoredObs = new Observatory(restored);
    await restoredObs.ready;
    let isolated = true;
    const restoredBalances: number[] = [];
    for (const [index, workspaceId] of workspaces.entries())
      await restored.scope.run(workspaceId, async () => {
        const sessions = await restoredObs.db.list();
        if (
          sessions.length !== 1 ||
          sessions[0].title !== `Restore fixture ${index}`
        )
          isolated = false;
        if (!(await restoredObs.db.detail(sessions[0].id))?.integrity)
          isolated = false;
        restoredBalances.push(
          await new FundingService(restored!, {
            enabled: false,
            recipient: "",
            rpcUrl: "https://fixture.invalid",
          }).ledger.balance(),
        );
      });
    evidence.workspaceIsolationPassed = isolated;
    evidence.financialBalancesMatch =
      JSON.stringify(balances) === JSON.stringify(restoredBalances) &&
      balances[0] === 7500000 &&
      balances[1] === 20000000;
    evidence.completedAt = new Date().toISOString();
    if (
      [
        evidence.backupEncrypted,
        evidence.authenticatedBeforeRestore,
        evidence.wrongPassphraseRejected,
        evidence.corruptionRejected,
        evidence.populatedDestinationRejected,
        evidence.activeRuntimeRejected,
        evidence.rowDigestsMatch,
        evidence.auditChainsValid,
        evidence.financialBalancesMatch,
        evidence.workspaceIsolationPassed,
      ].some((value) => !value)
    )
      throw new Error("Recovery drill checks failed.");
    return {
      ...evidence,
      backupSha256: backup.encryptedSha256,
      tablesVerified: recovery.tables.length,
      ledgerGroupsVerified: recovery.ledgerGroupsVerified,
      sourceDatabaseDropped: true,
      restoredDatabaseDropped: true,
    };
  } finally {
    await source?.close();
    await restored?.close();
    for (const name of created.reverse())
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    Object.assign(config.keys, original.keys);
    config.token = original.token;
    config.rpm = original.rpm;
    globalThis.fetch = original.fetch;
  }
}
