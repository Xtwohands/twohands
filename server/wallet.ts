import { createHash } from "node:crypto";
import type { ObservedCall } from "./observation-types.js";
import { shadowWalletPrice } from "./shadow-wallet.js";
import type { Store } from "./store.js";
import {
  depositPosting,
  fixedCostTavilyCall,
  holdOutcome,
} from "./wallet-rules.js";

export interface WalletStatus {
  /** True when this account's eligible paid calls are gated by its credits. */
  enforced: boolean;
  /** True once the account has any wallet activity, even while enforcement is paused. */
  active: boolean;
  postedMicros: number;
  heldMicros: number;
  availableMicros: number;
  chargedMicros: number;
  /** An unresolved payment dispute stops new paid admissions. */
  frozen: boolean;
}
export interface WalletDenial {
  /**
   * `rate_unverified`: the account is enrolled but its verified rate has
   * expired or no longer matches the provider credential, so the call cannot
   * be billed and is refused until an operator re-verifies the rate.
   */
  reason: "insufficient_balance" | "dispute_hold" | "rate_unverified";
  requiredMicros: number;
  availableMicros: number;
  heldMicros: number;
}
/** Refusal before dispatch. Nothing was reserved, charged or sent to a provider. */
export class WalletError extends Error {
  readonly code: "insufficient_credits" | "billing_unavailable";
  readonly status: number;
  constructor(public wallet: WalletDenial) {
    super(
      wallet.reason === "rate_unverified"
        ? "This paid tool is temporarily unavailable for this account. Continue with other tools or the evidence already gathered."
        : wallet.reason === "dispute_hold"
          ? "Paid tools are unavailable for this account while a payment is under review. Continue with free tools or the evidence already gathered."
          : "This account's available credits do not cover this paid tool call. Continue with free tools or the evidence already gathered.",
    );
    const unbillable = wallet.reason === "rate_unverified";
    this.code = unbillable ? "billing_unavailable" : "insufficient_credits";
    this.status = unbillable ? 409 : 402;
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
/** A rate row enrolls the account, whether or not the rate is still current. */
const enrollment = `SELECT rate_version, provider_account, credential_digest, provider_cost_micros,
         verified_at, expires_at, (verified_at<=now() AND expires_at>now()) AS current
  FROM wallet_rates WHERE workspace_id=${scope}`;
/** One row per workspace, whether or not the account has a balance row yet. */
const balanceRow = `SELECT COALESCE(b.posted_micros,0) AS posted,
         COALESCE(b.held_micros,0) AS held,
         COALESCE(b.charged_micros,0) AS charged,
         b.workspace_id IS NOT NULL AS active,
         EXISTS (
           SELECT 1 FROM wallet_journal d
           WHERE d.workspace_id=${scope} AND d.kind='dispute_hold' AND NOT EXISTS (
             SELECT 1 FROM wallet_journal r
             WHERE r.workspace_id=d.workspace_id AND r.deposit_id=d.deposit_id
               AND r.kind='dispute_release'
           )) AS frozen
  FROM (SELECT ${scope} AS id) w
  LEFT JOIN wallet_balances b ON b.workspace_id=w.id`;
const inactive: WalletStatus = {
  enforced: false,
  active: false,
  postedMicros: 0,
  heldMicros: 0,
  availableMicros: 0,
  chargedMicros: 0,
  frozen: false,
};

/**
 * Prepaid service credits for one account. Every method runs inside the
 * caller's workspace transaction or read.
 */
export class Wallet {
  private installed = false;
  constructor(private readonly store: Store) {}

  /**
   * False on SQLite and on a PostgreSQL schema that predates the wallet
   * migration, where every method is a no-op. The startup migration check
   * already refuses to serve a release whose migrations are pending; this
   * keeps tooling and recovery paths that skip that check from failing on
   * missing tables.
   */
  private async ready() {
    if (this.installed) return true;
    if (this.store.db.dialect !== "postgres") return false;
    const row = await this.store.db
      .prepare(
        "SELECT to_regclass('octolab.wallet_journal') IS NOT NULL AS installed",
      )
      .get();
    return (this.installed = row?.installed === true);
  }

  /**
   * Gate for every paid call of an enrolled account, in the transaction that
   * creates its receipt.
   *
   * - The rated configuration is held at its maximum charge (returns true).
   * - The rated configuration with a lapsed or mismatched rate fails closed.
   * - Any other paid call is not held or charged (returns false), but is
   *   refused while the account could not cover the rated hold, so an empty
   *   wallet cannot be worked around with an unrated variant.
   *
   * Free calls and accounts without a rate are untouched.
   */
  async admit(call: ObservedCall, providerCredential = "") {
    const { db } = this.store;
    if (!walletEnforcementEnabled() || !(await this.ready())) return false;
    const rate = await db.prepare(enrollment).get();
    if (!rate) return false;
    const rated =
      call.tool === "tavily_search" &&
      (call.arguments.searchDepth ?? "basic") === "basic" &&
      (call.arguments.maxResults ?? 10) === 10;
    if (!rated && !(call.estimateMicros > 0)) return false;

    const base = Number(rate.provider_cost_micros);
    const { markupBps, markupMicros, maximumMicros } = shadowWalletPrice(base);
    // All keys and sessions of the account serialize here. The workspace
    // transaction already holds this lock; taking it again is free and keeps
    // the balance check correct for any future caller.
    await db
      .prepare(`SELECT pg_advisory_xact_lock(hashtextextended(${scope},0))`)
      .get();
    const balance = (await db.prepare(balanceRow).get())!;
    const heldMicros = Number(balance.held);
    const availableMicros = Number(balance.posted) - heldMicros;
    const deny = (reason: WalletDenial["reason"]) =>
      new WalletError({
        reason,
        requiredMicros: maximumMicros,
        availableMicros: Math.max(0, availableMicros),
        heldMicros,
      });
    if (balance.frozen === true) throw deny("dispute_hold");
    if (availableMicros < maximumMicros) throw deny("insufficient_balance");
    if (!rated) return false;
    if (
      rate.current !== true ||
      !fixedCostTavilyCall(call, providerCredential) ||
      rate.provider_account !== call.providerAccountReference ||
      rate.credential_digest !== walletCredentialDigest(providerCredential)
    ) {
      // Operator alert: no customer data, only the rate that needs attention.
      console.error(
        `Wallet rate ${String(rate.rate_version)} is expired or no longer matches the provider credential. Billable calls are refused until it is re-verified.`,
      );
      throw deny("rate_unverified");
    }
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
        call.adapter!.version,
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
    if (!(await this.ready())) return;
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

    const { outcome, providerRequestId, reportedCredits } = holdOutcome(call);
    await db
      .prepare(
        "INSERT INTO wallet_hold_closures(call_id,outcome,provider_request_id,reported_credits) VALUES (?,?,?,?)",
      )
      .run(call.id, outcome, providerRequestId, reportedCredits);
    if (outcome === "posted")
      await db
        .prepare(
          "INSERT INTO wallet_journal(source_id,kind,wallet_micros) VALUES (?,'usage',?)",
        )
        .run(call.id, -Number(hold.total_micros));
  }

  /** Enrolls a deposit of an enrolled account while enforcement is on. */
  async enrollDeposit(depositId: string) {
    if (!walletEnforcementEnabled() || !(await this.ready())) return;
    await this.store.db
      .prepare(
        `INSERT INTO wallet_deposits(deposit_id) SELECT ? WHERE EXISTS (${enrollment})
         ON CONFLICT (workspace_id,deposit_id) DO NOTHING`,
      )
      .run(depositId);
  }

  /**
   * Converges an enrolled deposit on its verified net amount. Replays post
   * nothing; refunds and dispute holds append negative adjustments.
   *
   * `firstVerification` is true only when this reconciliation is the first to
   * see the payment as paid. A checkout prepared before the account was
   * enrolled, but first paid while enforcement is on, is enrolled here.
   * Payments already credited before enrollment are never backfilled.
   */
  async reconcileDeposit(
    depositId: string,
    paymentIntentId: string,
    targetMicros: number,
    disputed: boolean,
    firstVerification = false,
  ) {
    const { db } = this.store;
    if (!(await this.ready())) return;
    if (firstVerification) await this.enrollDeposit(depositId);
    const state = await db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM wallet_deposits WHERE workspace_id=${scope} AND deposit_id=?) AS enrolled,
                COALESCE(sum(wallet_micros),0) AS current,
                COALESCE(max(revision),0)+1 AS next_revision
         FROM wallet_journal WHERE workspace_id=${scope} AND deposit_id=?`,
      )
      .get(depositId, depositId);
    if (!state?.enrolled) return;
    const posting = depositPosting(
      Number(state.current),
      targetMicros,
      disputed,
    );
    if (!posting) return;
    await db
      .prepare(
        `INSERT INTO wallet_journal (source_id,revision,kind,reference,target_micros,wallet_micros)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (workspace_id,deposit_id,dispute_marker) DO NOTHING`,
      )
      .run(
        depositId,
        state.next_revision,
        posting.kind,
        paymentIntentId,
        targetMicros,
        posting.deltaMicros,
      );
  }

  /** Two single-row reads; safe to poll. */
  async status(): Promise<WalletStatus> {
    if (!(await this.ready())) return inactive;
    const row = await this.store.db
      .prepare(
        `SELECT s.*, EXISTS (${enrollment}) AS enrolled FROM (${balanceRow}) s`,
      )
      .get();
    if (!row) return inactive;
    const postedMicros = Number(row.posted),
      heldMicros = Number(row.held);
    return {
      enforced: walletEnforcementEnabled() && row.enrolled === true,
      active: row.active === true,
      postedMicros,
      heldMicros,
      availableMicros: Math.max(0, postedMicros - heldMicros),
      chargedMicros: Number(row.charged),
      frozen: row.frozen === true,
    };
  }
}
