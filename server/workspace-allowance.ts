import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { PostgresDatabase, type Row } from "./database.js";
import type { Store } from "./store.js";
export interface OperatorAllowance {
  enforced: boolean;
  state: "local" | "unconfigured" | "paused" | "exhausted" | "available";
  limitMicros: number;
  spentMicros: number;
  reservedMicros: number;
  remainingMicros: number | null;
  revision: number;
  basis: "estimated_provider_spend_since_activation";
}
export class AllowanceError extends Error {
  readonly code = "operator_allowance_exceeded";
  constructor(
    public status: number,
    message: string,
    public operatorAllowance?: OperatorAllowance,
  ) {
    super(message);
  }
}
function status(row?: Row, enforced = true): OperatorAllowance {
  const limitMicros = Number(row?.limit_micros ?? 0),
    spentMicros = Number(row?.spent_micros ?? 0),
    reservedMicros = Number(row?.reserved_micros ?? 0);
  const remainingMicros = Math.max(
    0,
    limitMicros - spentMicros - reservedMicros,
  );
  return {
    enforced,
    state: !enforced
      ? "local"
      : !row
        ? "unconfigured"
        : row.paused
          ? "paused"
          : remainingMicros === 0
            ? "exhausted"
            : "available",
    limitMicros,
    spentMicros,
    reservedMicros,
    remainingMicros: enforced ? remainingMicros : null,
    revision: Number(row?.revision ?? 0),
    basis: "estimated_provider_spend_since_activation",
  };
}
export function operatorAllows(value: OperatorAllowance, amount: number) {
  return (
    !value.enforced ||
    (value.state === "available" && amount <= value.remainingMicros!)
  );
}
const changeInput = z
  .object({
    requestKey: z.uuid(),
    revision: z.number().int().nonnegative(),
    limitMicros: z.number().int().min(0).max(1_000_000_000),
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
/** Platform authority is separate from customer key/session limits and payment balances. */
export class WorkspaceAllowance {
  constructor(private store: Store) {}
  async status() {
    if (this.store.db.dialect !== "postgres") return status(undefined, false);
    return status(
      await this.store.db
        .prepare("SELECT * FROM workspace_allowances WHERE workspace_id=?")
        .get(this.store.workspaceId),
    );
  }
  async assert(amount: number) {
    const current = await this.status();
    if (!operatorAllows(current, amount))
      throw new AllowanceError(
        403,
        "Provider execution is unavailable: the workspace operator allowance is paused, missing, or insufficient.",
        current,
      );
    return current;
  }
  async reserve(
    callId: string,
    source: "observation" | "task" | "provider_lab",
    amount: number,
  ) {
    if (this.store.db.dialect !== "postgres") return;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e9)
      throw Error("Invalid allowance reservation.");
    await this.store.db.atomic(async () => {
      const old = await this.store.db
        .prepare(
          "SELECT source,amount_micros FROM workspace_allowance_spend WHERE call_id=?",
        )
        .get(callId);
      if (old) {
        if (old.source !== source || Number(old.amount_micros) !== amount)
          throw Error("Allowance reservation differs.");
        return;
      }
      await this.assert(amount);
      await this.store.db
        .prepare(
          "INSERT INTO workspace_allowance_spend(call_id,source,amount_micros,state) VALUES(?,?,?,'reserved')",
        )
        .run(callId, source, amount);
      await this.store.db
        .prepare(
          "UPDATE workspace_allowances SET reserved_micros=reserved_micros+? WHERE workspace_id=?",
        )
        .run(amount, this.store.workspaceId);
    });
  }
  async settle(callId: string) {
    if (this.store.db.dialect !== "postgres") return;
    await this.store.db.atomic(async () => {
      const row = await this.store.db
        .prepare(
          "SELECT amount_micros FROM workspace_allowance_spend WHERE call_id=? AND state='reserved'",
        )
        .get(callId);
      if (!row) return; // Historical receipts predate activation and are not retroactively charged.
      await this.store.db
        .prepare(
          "UPDATE workspace_allowances SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+? WHERE workspace_id=?",
        )
        .run(row.amount_micros, row.amount_micros, this.store.workspaceId);
      await this.store.db
        .prepare(
          "UPDATE workspace_allowance_spend SET state='settled',settled_at=? WHERE call_id=?",
        )
        .run(new Date().toISOString(), callId);
    });
  }
  async recover() {
    if (this.store.db.dialect !== "postgres") return;
    await this.store.db.atomic(async () => {
      const rows = await this.store.db
        .prepare(
          "SELECT call_id FROM workspace_allowance_spend WHERE state='reserved'",
        )
        .all();
      for (const row of rows) await this.settle(String(row.call_id));
    });
  }
  private database() {
    if (!(this.store.db instanceof PostgresDatabase))
      throw new AllowanceError(
        503,
        "Hosted workspace allowances require PostgreSQL.",
      );
    return this.store.db;
  }
  async list(after?: string) {
    const cursor = after ? z.uuid().parse(after) : "";
    const rows = await this.database().pool.query(
      "SELECT w.id,w.name,a.limit_micros,a.spent_micros,a.reserved_micros,a.paused,a.revision FROM octolab.workspaces w LEFT JOIN octolab.workspace_allowances a ON a.workspace_id=w.id WHERE w.id>$1 ORDER BY w.id LIMIT 51",
      [cursor],
    );
    return {
      items: rows.rows.slice(0, 50).map((r) => ({
        workspaceId: r.id,
        name: r.name,
        operatorAllowance: status(r.limit_micros === null ? undefined : r),
      })),
      nextCursor: rows.rows.length > 50 ? rows.rows[49].id : null,
    };
  }
  async change(workspaceId: string, actorId: string, raw: unknown) {
    z.uuid().parse(workspaceId);
    z.uuid().parse(actorId);
    const input = changeInput.parse(raw),
      hash = createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      client = await this.database().pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [workspaceId],
      );
      if (
        !(
          await client.query("SELECT 1 FROM octolab.workspaces WHERE id=$1", [
            workspaceId,
          ])
        ).rowCount
      )
        throw new AllowanceError(404, "Workspace not found.");
      const replay = await client.query(
        "SELECT input_hash FROM octolab.workspace_allowance_events WHERE workspace_id=$1 AND actor_user_id=$2 AND request_key=$3",
        [workspaceId, actorId, input.requestKey],
      );
      const previous = (
        await client.query(
          "SELECT * FROM octolab.workspace_allowances WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0];
      if (replay.rowCount) {
        if (replay.rows[0].input_hash !== hash)
          throw new AllowanceError(
            409,
            "This allowance request key was used with different settings.",
          );
        await client.query("COMMIT");
        return { operatorAllowance: status(previous), replayed: true };
      }
      if (Number(previous?.revision ?? 0) !== input.revision)
        throw new AllowanceError(
          409,
          "Allowance settings changed. Reload before editing.",
        );
      if (
        input.limitMicros <
        Number(previous?.spent_micros ?? 0) +
          Number(previous?.reserved_micros ?? 0)
      )
        throw new AllowanceError(
          409,
          "The allowance cannot be reduced below spent and reserved estimates. Pause it to block new calls.",
        );
      const updated = await client.query(
        "INSERT INTO octolab.workspace_allowances(workspace_id,limit_micros,paused) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET limit_micros=excluded.limit_micros,paused=excluded.paused,revision=workspace_allowances.revision+1,updated_at=now() RETURNING *",
        [workspaceId, input.limitMicros, input.paused],
      );
      const current = status(updated.rows[0]);
      await client.query(
        "INSERT INTO octolab.workspace_allowance_events(id,workspace_id,actor_user_id,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          workspaceId,
          actorId,
          input.requestKey,
          hash,
          JSON.stringify({
            previous: status(previous),
            current,
            reason: input.reason,
          }),
        ],
      );
      await client.query("COMMIT");
      return { operatorAllowance: current, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Quotes describe estimates; final admission rechecks the current operator allowance atomically. */
export function applyOperatorAllowance<
  T extends {
    requestEstimates: {
      operationIndex: number;
      estimatedMicros: number;
      withinBudget: boolean;
    }[];
    discoveryMatches: {
      operationIndex: number;
      status: string;
      reason: string;
    }[];
  },
>(tools: T[], allowance: OperatorAllowance): T[] {
  for (const tool of tools) {
    for (const estimate of tool.requestEstimates) {
      const allowed = operatorAllows(allowance, estimate.estimatedMicros);
      Object.assign(estimate, { operatorAllowed: allowed });
      if (!allowed) estimate.withinBudget = false;
    }
    for (const match of tool.discoveryMatches) {
      const estimate = tool.requestEstimates.find(
        (e) => e.operationIndex === match.operationIndex,
      );
      if (
        estimate &&
        !operatorAllows(allowance, estimate.estimatedMicros) &&
        (match.status === "eligible" || match.status === "over_budget")
      ) {
        match.status = "disabled";
        match.reason =
          "Workspace operator allowance is paused, missing, or insufficient. This quote does not authorize provider execution.";
      }
    }
  }
  return tools;
}
