import type { Store } from "./store.js";
import type { FundingEntry } from "./funding-types.js";

/** Internal test-credit units. No live currency balance or provider-spend authorization. */
export class FundingLedger {
  constructor(public store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS funding_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL CHECK(source IN ('onchain','stripe')),
      source_id TEXT NOT NULL, revision INTEGER NOT NULL, delta_units INTEGER NOT NULL CHECK(delta_units!=0),
      kind TEXT NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(source,source_id,revision));`);
    // Historical on-chain receipts stay intact. Import each exactly once.
    store.db
      .prepare(
        `INSERT OR IGNORE INTO funding_ledger(source,source_id,revision,delta_units,kind,reference,created_at)
      SELECT 'onchain',intent_id,0,amount_units,'deposit',transaction_hash,created_at FROM funding_credits`,
      )
      .run();
  }
  balance() {
    return Number(
      this.store.db
        .prepare("SELECT COALESCE(SUM(delta_units),0) AS n FROM funding_ledger")
        .get()!.n,
    );
  }
  net(source: "onchain" | "stripe", id: string) {
    return Number(
      this.store.db
        .prepare(
          "SELECT COALESCE(SUM(delta_units),0) AS n FROM funding_ledger WHERE source=? AND source_id=?",
        )
        .get(source, id)!.n,
    );
  }
  /** Caller owns the enclosing transaction, including the payment receipt state. */
  settle(
    source: "onchain" | "stripe",
    id: string,
    targetUnits: number,
    reference: string,
    kind: string,
    at: string,
  ) {
    if (
      !Number.isSafeInteger(targetUnits) ||
      targetUnits < 0 ||
      targetUnits > 1000000000
    )
      throw new Error("Invalid funding ledger target");
    const delta = targetUnits - this.net(source, id);
    if (!delta) return;
    const revision = Number(
      this.store.db
        .prepare(
          "SELECT COALESCE(MAX(revision),-1)+1 AS n FROM funding_ledger WHERE source=? AND source_id=?",
        )
        .get(source, id)!.n,
    );
    this.store.db
      .prepare(
        "INSERT INTO funding_ledger(source,source_id,revision,delta_units,kind,reference,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(source, id, revision, delta, kind, reference, at);
  }
  entries(): FundingEntry[] {
    return this.store.db
      .prepare(
        "SELECT id,source,source_id AS sourceId,delta_units AS deltaUnits,kind,reference,created_at AS createdAt FROM funding_ledger ORDER BY id DESC LIMIT 100",
      )
      .all() as unknown as FundingEntry[];
  }
}
