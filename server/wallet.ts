import { createHash } from "node:crypto";
import type { ObservedCall } from "./observation-types.js";
import { shadowWalletPrice } from "./shadow-wallet.js";
import type { Store } from "./store.js";

export interface WalletStatus {
  /** True when this account's eligible paid calls are gated by its credits. */
  enforced: boolean;
  postedMicros: number;
  heldMicros: number;
  availableMicros: number;
  chargedMicros: number;
  /** An unresolved payment dispute stops new paid admissions. */
  frozen: boolean;
}
export interface WalletDenial {
  reason: "insufficient_balance" | "dispute_hold";
  requiredMicros: number;
  availableMicros: number;
  heldMicros: number;
}
/** Refusal before dispatch. Nothing was reserved, charged or sent to a provider. */
export class WalletError extends Error {
  readonly code = "insufficient_credits";
  readonly status = 402;
  constructor(public wallet: WalletDenial) {
    super(
      wallet.reason === "dispute_hold"
        ? "Paid tools are unavailable for this account while a payment is under review. Continue with free tools or the evidence already gathered."
        : "This account's available credits do not cover this paid tool call. Continue with free tools or the evidence already gathered.",
    );
  }
}

export function walletEnforcementEnabled() {
  return process.env.TWO_HANDS_WALLET_ENFORCEMENT === "true";
}

/** Private rate binding. A provider credential change requires re-verification. */
export function walletCredentialDigest(credential: string) {
  return createHash("sha256")
    .update("two-hands-wallet-tavily-v1\0")
    .update(credential)
    .digest("hex");
}

const scope = "current_setting('octolab.workspace_id')";
const unresolvedDispute = `EXISTS (
  SELECT 1 FROM wallet_journal d
  WHERE d.workspace_id=${scope} AND d.kind='dispute_hold' AND NOT EXISTS (
    SELECT 1 FROM wallet_journal r
    WHERE r.workspace_id=d.workspace_id AND r.deposit_id=d.deposit_id AND r.kind='dispute_release'
  ))`;

/**
 * Prepaid service credits for one account. Every method runs inside the
 * caller's workspace transaction, whose lock serializes all keys and sessions
 * of that account.
 */
export class Wallet {
  constructor(private readonly store: Store) {}

  private get hosted() {
    return this.store.db.dialect === "postgres";
  }

  private activeRate() {
    return `SELECT rate_version, provider_account, provider_cost_micros, verified_at, expires_at
            FROM wallet_rates
            WHERE workspace_id=${scope} AND verified_at<=now() AND expires_at>now()`;
  }

  /**
   * Holds the maximum charge for a billable call in the transaction that
   * creates its receipt. Returns false when the call is outside wallet billing
   * and throws WalletError when available credits are too low.
   */
  async admit(call: ObservedCall, providerCredential: string) {
    const { db } = this.store;
    if (
      !walletEnforcementEnabled() ||
      !this.hosted ||
      call.tool !== "tavily_search" ||
      (call.arguments.searchDepth ?? "basic") !== "basic" ||
      (call.arguments.maxResults ?? 10) !== 10 ||
      !call.providerAccountReference ||
      !providerCredential ||
      call.adapter?.version !== "1.0.0"
    )
      return false;
    const rate = await db
      .prepare(
        `${this.activeRate()} AND provider_account=? AND credential_digest=?`,
      )
      .get(
        call.providerAccountReference,
        walletCredentialDigest(providerCredential),
      );
    if (!rate) return false;

    const base = Number(rate.provider_cost_micros);
    const { markupBps, markupMicros, maximumMicros } = shadowWalletPrice(base);
    await db
      .prepare(
        `INSERT INTO wallet_balances (workspace_id) VALUES (${scope}) ON CONFLICT (workspace_id) DO NOTHING`,
      )
      .run();
    const balance = (await db
      .prepare(
        `SELECT posted_micros, held_micros, ${unresolvedDispute} AS frozen
         FROM wallet_balances WHERE workspace_id=${scope} FOR UPDATE`,
      )
      .get())!;
    const heldMicros = Number(balance.held_micros);
    const availableMicros = Number(balance.posted_micros) - heldMicros;
    if (balance.frozen === true || availableMicros < maximumMicros)
      throw new WalletError({
        reason:
          balance.frozen === true ? "dispute_hold" : "insufficient_balance",
        requiredMicros: maximumMicros,
        availableMicros: Math.max(0, availableMicros),
        heldMicros,
      });
    await db
      .prepare(
        `INSERT INTO wallet_holds
         (call_id,key_id,tool,search_depth,max_results,adapter_version,provider_account,
          rate_version,rate_verified_at,rate_expires_at,provider_cost_micros,markup_bps,markup_micros,maximum_micros)
         VALUES (?,?,'tavily_search','basic',10,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        call.id,
        call.apiKeyId ?? null,
        call.adapter.version,
        rate.provider_account,
        rate.rate_version,
        rate.verified_at,
        rate.expires_at,
        base,
        markupBps,
        markupMicros,
        maximumMicros,
      );
    return true;
  }

  /**
   * Closes an open hold with the saved call outcome: one debit of the frozen
   * cost plus markup for a billable result, otherwise a release at zero charge.
   * Works after the flag or rate is turned off, and is a no-op without a hold.
   */
  async close(call: ObservedCall) {
    const { db } = this.store;
    if (!this.hosted) return;
    const hold = await db
      .prepare(
        `SELECT h.total_micros FROM wallet_holds h
         WHERE h.workspace_id=${scope} AND h.call_id=? AND NOT EXISTS (
           SELECT 1 FROM wallet_hold_closures c
           WHERE c.workspace_id=h.workspace_id AND c.call_id=h.call_id
         )`,
      )
      .get(call.id);
    if (!hold) return;

    const reported = (call.result?.usage as { credits?: number } | undefined)
      ?.credits;
    const providerRequestId = call.result?.requestId;
    const outcome =
      call.status === "interrupted"
        ? "interrupted"
        : call.status !== "succeeded"
          ? "failed"
          : reported !== undefined && reported !== 1
            ? "cost_conflict"
            : "posted";
    await db
      .prepare(
        "INSERT INTO wallet_hold_closures(call_id,outcome,provider_request_id,reported_credits) VALUES (?,?,?,?)",
      )
      .run(
        call.id,
        outcome,
        typeof providerRequestId === "string" && providerRequestId.length
          ? providerRequestId.slice(0, 200)
          : null,
        reported ?? null,
      );
    if (outcome === "posted")
      await db
        .prepare(
          "INSERT INTO wallet_journal(source_id,kind,wallet_micros) VALUES (?,'usage',?)",
        )
        .run(call.id, -Number(hold.total_micros));
  }

  /** Enrolls a new checkout intent of an enrolled account, inside its creation transaction. */
  async enrollDeposit(depositId: string) {
    if (!walletEnforcementEnabled() || !this.hosted) return;
    await this.store.db
      .prepare(
        `INSERT INTO wallet_deposits(deposit_id) SELECT ? WHERE EXISTS (${this.activeRate()})`,
      )
      .run(depositId);
  }

  /**
   * Converges an enrolled deposit on its verified net amount. Replays post
   * nothing; refunds and dispute holds append negative adjustments.
   */
  async reconcileDeposit(
    depositId: string,
    paymentIntentId: string,
    targetMicros: number,
    disputed: boolean,
  ) {
    const { db } = this.store;
    if (!this.hosted) return;
    const state = await db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM wallet_deposits WHERE workspace_id=${scope} AND deposit_id=?) AS enrolled,
                COALESCE(sum(wallet_micros),0) AS current,
                COALESCE(max(revision),0)+1 AS next_revision
         FROM wallet_journal WHERE workspace_id=${scope} AND deposit_id=?`,
      )
      .get(depositId, depositId);
    if (!state?.enrolled) return;
    const delta = targetMicros - Number(state.current);
    if (!delta && !disputed) return;
    await db
      .prepare(
        `INSERT INTO wallet_journal (source_id,revision,kind,reference,target_micros,wallet_micros)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (workspace_id,deposit_id,dispute_marker) DO NOTHING`,
      )
      .run(
        depositId,
        state.next_revision,
        disputed ? "dispute_hold" : delta < 0 ? "refund" : "deposit",
        paymentIntentId,
        targetMicros,
        delta,
      );
  }

  async status(): Promise<WalletStatus> {
    const empty = {
      enforced: false,
      postedMicros: 0,
      heldMicros: 0,
      availableMicros: 0,
      chargedMicros: 0,
      frozen: false,
    };
    if (!this.hosted) return empty;
    const row = await this.store.db
      .prepare(
        `SELECT EXISTS (${this.activeRate()}) AS enrolled,
                COALESCE((SELECT posted_micros FROM wallet_balances WHERE workspace_id=${scope}),0) AS posted,
                COALESCE((SELECT held_micros FROM wallet_balances WHERE workspace_id=${scope}),0) AS held,
                COALESCE((SELECT -sum(wallet_micros) FROM wallet_journal WHERE workspace_id=${scope} AND kind='usage'),0) AS charged,
                ${unresolvedDispute} AS frozen`,
      )
      .get();
    if (!row) return empty;
    const postedMicros = Number(row.posted),
      heldMicros = Number(row.held);
    return {
      enforced: walletEnforcementEnabled() && row.enrolled === true,
      postedMicros,
      heldMicros,
      availableMicros: Math.max(0, postedMicros - heldMicros),
      chargedMicros: Number(row.charged),
      frozen: row.frozen === true,
    };
  }
}
