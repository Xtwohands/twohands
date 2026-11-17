import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import Stripe from "stripe";
import { z } from "zod";
import { PostgresDatabase } from "./database.js";
import { FundingError } from "./funding.js";
import type { StripeDeposit, StripeMode } from "./funding-types.js";
import {
  REFUND_POLICY_VERSION,
  refundableByPayment,
  unusedRefundsEnabled,
  type RefundablePayment,
} from "./refund-policy.js";
import { stripeModeOf, type StripeFundingService } from "./stripe-funding.js";

/**
 * Operator money actions on an account wallet: releasing a dispute freeze and
 * refunding unused credit to the card that paid for it.
 *
 * These are the only application paths that post `dispute_release` entries or
 * create refund requests. They run on the database owner connection, under
 * the same per-account lock as call admission, so the runtime role keeps no
 * permission to do either. Every action is verified against Stripe first and
 * leaves an immutable `wallet_operator_actions` record.
 */

export const releaseInput = z
  .object({
    requestKey: z.uuid(),
    note: z
      .string()
      .trim()
      .min(10, "Add a note of at least 10 characters.")
      .max(4000),
  })
  .strict();
export const refundInput = z
  .object({
    requestKey: z.uuid(),
    amount: z
      .string()
      .regex(
        /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/,
        "Use a USD amount with up to two decimal places.",
      )
      .transform((s) => {
        const [whole, fraction = ""] = s.split(".");
        return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
      })
      .pipe(z.number().int().min(1, "Refund at least $0.01.")),
    note: z
      .string()
      .trim()
      .min(10, "Add a note of at least 10 characters.")
      .max(4000),
  })
  .strict();

export type RefundRequestStatus =
  "reserved" | "submitted" | "completed" | "failed";
export interface RefundRequest {
  id: string;
  depositId: string;
  amountCents: number;
  status: RefundRequestStatus;
  stripeRefundId: string | null;
  policyVersion: string;
  actor: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}
export interface RefundQuote {
  payment: StripeDeposit;
  mode: StripeMode;
  /** False until the owner approves a refund policy and enables refunds. */
  refundsEnabled: boolean;
  policyVersion: string;
  refundableCents: number;
  availableMicros: number;
  frozen: boolean;
  requests: RefundRequest[];
}
export interface DisputeRelease {
  payment: StripeDeposit;
  outcome: "won" | "lost";
  restoredMicros: number;
  replayed: boolean;
}

const CLOSED_IN_OUR_FAVOR = new Set(["won", "warning_closed"]);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requestRow = (r: Record<string, unknown>): RefundRequest => ({
  id: String(r.id),
  depositId: String(r.deposit_id),
  amountCents: Number(r.amount_cents),
  status: r.status as RefundRequestStatus,
  stripeRefundId:
    r.stripe_refund_id === null ? null : String(r.stripe_refund_id),
  policyVersion: String(r.policy_version),
  actor: String(r.actor),
  note: String(r.note),
  createdAt: new Date(r.created_at as string).toISOString(),
  updatedAt: new Date(r.updated_at as string).toISOString(),
});
/** The payment facts an operator action was decided on. A change means: look again. */
const evidence = (p: StripeDeposit) =>
  hash([
    p.amountCents,
    p.paymentIntentId,
    p.chargeId,
    p.refundedCents,
    p.disputed,
    p.netCreditUnits,
  ]);

export class WalletOperations {
  constructor(
    private stripe: StripeFundingService,
    private now = () => Date.now(),
  ) {}

  private database() {
    const { db } = this.stripe.funding.store;
    if (!(db instanceof PostgresDatabase))
      throw new FundingError(
        503,
        "Wallet operations need the hosted account wallet.",
      );
    return db;
  }
  private async workspaceOf(depositId: string) {
    const rows = await this.database().pool.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM octolab.stripe_deposits WHERE id=$1 LIMIT 2",
      [depositId],
    );
    if (rows.rows.length !== 1)
      throw new FundingError(
        rows.rows.length ? 409 : 404,
        "Payment could not be uniquely identified.",
      );
    return rows.rows[0].workspace_id;
  }
  /** Runs as the database owner under the account lock that admission takes. */
  private async owner<T>(
    workspaceId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database().pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [workspaceId],
      );
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private inAccount<T>(workspaceId: string, action: () => Promise<T>) {
    return this.stripe.funding.store.scope.run(workspaceId, action);
  }
  /** The wallet deposit behind a payment, locked, or a refusal when the payment does not fund a wallet. */
  private async walletDeposit(
    client: PoolClient,
    workspaceId: string,
    depositId: string,
  ) {
    const row = (
      await client.query(
        `SELECT d.body, w.mode FROM octolab.stripe_deposits d
         JOIN octolab.wallet_deposits w ON w.workspace_id=d.workspace_id AND w.deposit_id=d.id
         WHERE d.workspace_id=$1 AND d.id=$2 FOR UPDATE OF d`,
        [workspaceId, depositId],
      )
    ).rows[0];
    if (!row)
      throw new FundingError(
        409,
        "This payment does not fund an account wallet. Nothing was changed.",
      );
    const payment = JSON.parse(row.body) as StripeDeposit;
    if (stripeModeOf(payment) !== row.mode)
      throw new FundingError(
        409,
        "This payment's mode does not match its wallet. Nothing was changed.",
      );
    return { payment, mode: row.mode as StripeMode };
  }
  private async saveDeposit(
    client: PoolClient,
    workspaceId: string,
    payment: StripeDeposit,
    event: string,
  ) {
    payment.updatedAt = new Date(this.now()).toISOString();
    await client.query(
      "UPDATE octolab.stripe_deposits SET body=$3 WHERE workspace_id=$1 AND id=$2",
      [workspaceId, payment.id, JSON.stringify(payment)],
    );
    await client.query(
      "INSERT INTO octolab.stripe_deposit_events(workspace_id,deposit_id,body) VALUES ($1,$2,$3)",
      [
        workspaceId,
        payment.id,
        JSON.stringify({
          event,
          at: payment.updatedAt,
          status: payment.status,
          sessionId: payment.checkoutSessionId,
          paymentIntentId: payment.paymentIntentId,
          chargeId: payment.chargeId,
          amountCents: payment.amountCents,
          refundedCents: payment.refundedCents,
          netCreditUnits: payment.netCreditUnits,
        }),
      ],
    );
  }
  private async journalState(
    client: PoolClient,
    workspaceId: string,
    depositId: string,
  ) {
    const row = (
      await client.query(
        `SELECT COALESCE(sum(wallet_micros) FILTER (WHERE kind<>'dispute_release'),0) AS net,
                COALESCE(max(revision),0)+1 AS next_revision,
                bool_or(kind='dispute_hold') AS held,
                bool_or(kind='dispute_release') AS released
         FROM octolab.wallet_journal WHERE workspace_id=$1 AND deposit_id=$2`,
        [workspaceId, depositId],
      )
    ).rows[0];
    return {
      netMicros: Number(row.net),
      nextRevision: Number(row.next_revision),
      held: row.held === true,
      released: row.released === true,
    };
  }
  private async record(
    client: PoolClient,
    action: {
      workspaceId: string;
      depositId: string;
      mode: StripeMode;
      kind: "dispute_release" | "refund_request" | "refund_resolution";
      actor: string;
      requestKey: string;
      inputHash: string;
      data: unknown;
    },
  ) {
    await client.query(
      `INSERT INTO octolab.wallet_operator_actions
       (id,workspace_id,deposit_id,mode,kind,actor,request_key,input_hash,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        action.workspaceId,
        action.depositId,
        action.mode,
        action.kind,
        action.actor,
        action.requestKey,
        action.inputHash,
        JSON.stringify(action.data),
      ],
    );
  }

  /**
   * Lifts the freeze a dispute placed on an account, after Stripe has closed
   * every dispute on the payment. Stripe's outcome, not the operator, decides
   * the credits: a payment Stripe reinstated gets its remaining credits back,
   * and a lost dispute restores nothing (less any part not lost).
   */
  async releaseDispute(
    depositId: string,
    raw: unknown,
    actor: string,
  ): Promise<DisputeRelease> {
    const input = releaseInput.parse(raw);
    const inputHash = hash({ depositId, input, actor });
    const workspaceId = await this.workspaceOf(depositId);
    const previous = await this.database().pool.query(
      "SELECT input_hash,data FROM octolab.wallet_operator_actions WHERE request_key=$1",
      [input.requestKey],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].input_hash !== inputHash)
        throw new FundingError(
          409,
          "This request key was already used with different details.",
        );
      return {
        payment: await this.inAccount(workspaceId, () =>
          this.stripe.get(depositId),
        ),
        outcome: previous.rows[0].data.outcome,
        restoredMicros: Number(previous.rows[0].data.restoredMicros),
        replayed: true,
      };
    }
    // Read the payment and its disputes from Stripe before deciding anything.
    const verified = await this.inAccount(workspaceId, () =>
      this.stripe.reconcile(depositId),
    );
    if (!verified.disputed || !verified.paymentIntentId)
      throw new FundingError(409, "This payment has no dispute hold.");
    const disputes = await this.stripe.disputesFor(verified);
    if (!disputes.length)
      throw new FundingError(
        409,
        "Stripe reports no dispute for this payment. Nothing was released.",
      );
    const open = disputes.filter(
      (d) => !CLOSED_IN_OUR_FAVOR.has(d.status) && d.status !== "lost",
    );
    if (open.length)
      throw new FundingError(
        409,
        "Stripe has not closed the dispute on this payment. Nothing was released.",
      );
    const lostCents = disputes
      .filter((d) => d.status === "lost")
      .reduce((sum, d) => sum + d.amount, 0);
    const outcome = lostCents ? "lost" : "won";
    return await this.owner(workspaceId, async (client) => {
      const { payment, mode } = await this.walletDeposit(
        client,
        workspaceId,
        depositId,
      );
      if (evidence(payment) !== evidence(verified))
        throw new FundingError(
          409,
          "The payment changed while it was being reviewed. Check it again.",
        );
      const journal = await this.journalState(client, workspaceId, depositId);
      if (!journal.held)
        throw new FundingError(409, "This payment has no dispute hold.");
      if (journal.released)
        throw new FundingError(
          409,
          "The dispute hold on this payment was already released.",
        );
      const refundedCents = Math.max(
        payment.refundedCents,
        payment.refundedCents + (payment.pendingRefundCents ?? 0),
      );
      const restoredMicros =
        Math.max(0, payment.amountCents - refundedCents - lostCents) * 10000;
      await client.query(
        `INSERT INTO octolab.wallet_journal
         (workspace_id,source_id,revision,kind,reference,wallet_micros,mode)
         VALUES ($1,$2,$3,'dispute_release',$4,$5,$6)`,
        [
          workspaceId,
          depositId,
          journal.nextRevision,
          `operator-release:${input.requestKey}`,
          restoredMicros,
          mode,
        ],
      );
      payment.disputeResolution = {
        outcome,
        restoredMicros,
        releasedAt: new Date(this.now()).toISOString(),
      };
      payment.message = restoredMicros
        ? "The dispute on this payment was closed and its remaining credits were restored."
        : "The dispute on this payment was closed. Its credits were not restored.";
      await this.saveDeposit(client, workspaceId, payment, "dispute_released");
      await this.record(client, {
        workspaceId,
        depositId,
        mode,
        kind: "dispute_release",
        actor,
        requestKey: input.requestKey,
        inputHash,
        data: {
          outcome,
          restoredMicros,
          note: input.note,
          disputes: disputes.map((d) => ({
            id: d.id,
            status: d.status,
            amountCents: d.amount,
          })),
        },
      });
      return { payment, outcome, restoredMicros, replayed: false };
    });
  }

  /** What the refund policy allows for one payment, from saved state only. */
  private async refundState(
    client: Pick<PoolClient, "query">,
    workspaceId: string,
    depositId: string,
    mode: StripeMode,
  ) {
    const balance = (
      await client.query(
        `SELECT COALESCE(b.posted_micros,0) AS posted, COALESCE(b.held_micros,0) AS held,
                EXISTS (
                  SELECT 1 FROM octolab.wallet_journal d
                  WHERE d.workspace_id=$1 AND d.mode=$2 AND d.kind='dispute_hold' AND NOT EXISTS (
                    SELECT 1 FROM octolab.wallet_journal r
                    WHERE r.workspace_id=d.workspace_id AND r.deposit_id=d.deposit_id
                      AND r.kind='dispute_release')) AS frozen
         FROM (SELECT 1) one
         LEFT JOIN octolab.wallet_balances b ON b.workspace_id=$1 AND b.mode=$2`,
        [workspaceId, mode],
      )
    ).rows[0];
    const payments: RefundablePayment[] = (
      await client.query(
        `SELECT d.body,
                COALESCE((SELECT max(r.expected_refunded_cents) FROM octolab.wallet_refund_requests r
                          WHERE r.workspace_id=d.workspace_id AND r.deposit_id=d.id
                            AND r.status IN ('reserved','submitted')),0) AS pending
         FROM octolab.wallet_deposits w
         JOIN octolab.stripe_deposits d ON d.workspace_id=w.workspace_id AND d.id=w.deposit_id
         WHERE w.workspace_id=$1 AND w.mode=$2`,
        [workspaceId, mode],
      )
    ).rows.map((row) => {
      const p = JSON.parse(row.body) as StripeDeposit;
      return {
        id: p.id,
        createdAt: p.createdAt,
        disputed: p.disputed,
        // Only a verified, undisputed payment has anything to refund.
        remainingCents:
          p.paymentIntentId &&
          (p.status === "credited" || p.status === "partially_refunded")
            ? Math.max(
                0,
                p.amountCents - Math.max(p.refundedCents, Number(row.pending)),
              )
            : 0,
      };
    });
    const availableMicros = Number(balance.posted) - Number(balance.held);
    const frozen = balance.frozen === true;
    return {
      availableMicros,
      frozen,
      refundableCents:
        refundableByPayment({ availableMicros, frozen, payments }).get(
          depositId,
        ) ?? 0,
    };
  }
  private async requests(
    client: Pick<PoolClient, "query">,
    workspaceId: string,
    depositId: string,
  ) {
    return (
      await client.query(
        "SELECT * FROM octolab.wallet_refund_requests WHERE workspace_id=$1 AND deposit_id=$2 ORDER BY created_at DESC LIMIT 50",
        [workspaceId, depositId],
      )
    ).rows.map(requestRow);
  }
  /** Marks requests whose refund Stripe has since reported. Saved state only. */
  private async settleReported(workspaceId: string, depositId: string) {
    await this.database().pool.query(
      `UPDATE octolab.wallet_refund_requests r SET status='completed', updated_at=now()
       FROM octolab.stripe_deposits d
       WHERE r.workspace_id=$1 AND r.deposit_id=$2 AND r.status='submitted'
         AND d.workspace_id=r.workspace_id AND d.id=r.deposit_id
         AND (d.body::jsonb->>'refundedCents')::int >= r.expected_refunded_cents`,
      [workspaceId, depositId],
    );
  }

  async refundQuote(depositId: string): Promise<RefundQuote> {
    const workspaceId = await this.workspaceOf(depositId);
    await this.settleReported(workspaceId, depositId);
    const pool = this.database().pool;
    const payment = await this.inAccount(workspaceId, () =>
      this.stripe.get(depositId),
    );
    const mode = stripeModeOf(payment);
    const enrolled = await pool.query(
      "SELECT 1 FROM octolab.wallet_deposits WHERE workspace_id=$1 AND deposit_id=$2",
      [workspaceId, depositId],
    );
    const state = enrolled.rowCount
      ? await this.refundState(pool, workspaceId, depositId, mode)
      : { availableMicros: 0, frozen: false, refundableCents: 0 };
    return {
      payment,
      mode,
      refundsEnabled: unusedRefundsEnabled(),
      policyVersion: REFUND_POLICY_VERSION,
      ...state,
      availableMicros: Math.max(0, state.availableMicros),
      requests: await this.requests(pool, workspaceId, depositId),
    };
  }

  /**
   * Refunds unused credit from one payment to its card.
   *
   * The amount leaves the balance, in the same transaction that records the
   * request, before Stripe is asked for anything. If Stripe then refuses, the
   * request is marked failed and reconciliation returns the credits. If the
   * answer is lost, the amount stays reserved until `resolveRefund` finds out
   * what Stripe did.
   */
  async requestRefund(
    depositId: string,
    raw: unknown,
    actor: string,
  ): Promise<RefundQuote> {
    const input = refundInput.parse(raw);
    const inputHash = hash({ depositId, input, actor });
    const workspaceId = await this.workspaceOf(depositId);
    const pool = this.database().pool;
    const previous = await pool.query(
      "SELECT input_hash FROM octolab.wallet_refund_requests WHERE request_key=$1",
      [input.requestKey],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].input_hash !== inputHash)
        throw new FundingError(
          409,
          "This request key was already used with different details.",
        );
      return this.refundQuote(depositId);
    }
    if (!unusedRefundsEnabled())
      throw new FundingError(
        409,
        "Refunds of unused credits are not enabled. No refund was started.",
      );
    const verified = await this.inAccount(workspaceId, () =>
      this.stripe.reconcile(depositId),
    );
    await this.settleReported(workspaceId, depositId);
    const requestId = randomUUID();
    await this.owner(workspaceId, async (client) => {
      const { payment, mode } = await this.walletDeposit(
        client,
        workspaceId,
        depositId,
      );
      if (evidence(payment) !== evidence(verified))
        throw new FundingError(
          409,
          "The payment changed while it was being reviewed. Check it again.",
        );
      if (
        !payment.paymentIntentId ||
        payment.disputed ||
        (payment.status !== "credited" &&
          payment.status !== "partially_refunded")
      )
        throw new FundingError(
          409,
          "Only a verified, undisputed payment can be refunded. No refund was started.",
        );
      const active = await client.query(
        "SELECT 1 FROM octolab.wallet_refund_requests WHERE workspace_id=$1 AND deposit_id=$2 AND status IN ('reserved','submitted')",
        [workspaceId, depositId],
      );
      if (active.rowCount)
        throw new FundingError(
          409,
          "A refund for this payment is still in progress. Resolve it before starting another.",
        );
      const { refundableCents } = await this.refundState(
        client,
        workspaceId,
        depositId,
        mode,
      );
      if (input.amount > refundableCents)
        throw new FundingError(
          409,
          `At most $${(refundableCents / 100).toFixed(2)} of this payment is unused and refundable. No refund was started.`,
        );
      const expectedRefundedCents = payment.refundedCents + input.amount;
      const targetMicros =
        (payment.amountCents - expectedRefundedCents) * 10000;
      const journal = await this.journalState(client, workspaceId, depositId);
      const deltaMicros = targetMicros - journal.netMicros;
      if (deltaMicros >= 0 || deltaMicros !== -input.amount * 10000)
        throw new FundingError(
          409,
          "This payment's wallet entries do not match its verified amount. No refund was started.",
        );
      await client.query(
        `INSERT INTO octolab.wallet_refund_requests
         (id,workspace_id,deposit_id,mode,amount_cents,expected_refunded_cents,status,
          policy_version,actor,note,request_key,input_hash)
         VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9,$10,$11)`,
        [
          requestId,
          workspaceId,
          depositId,
          mode,
          input.amount,
          expectedRefundedCents,
          REFUND_POLICY_VERSION,
          actor,
          input.note,
          input.requestKey,
          inputHash,
        ],
      );
      await client.query(
        `INSERT INTO octolab.wallet_journal
         (workspace_id,source_id,revision,kind,reference,target_micros,wallet_micros,mode)
         VALUES ($1,$2,$3,'refund',$4,$5,$6,$7)`,
        [
          workspaceId,
          depositId,
          journal.nextRevision,
          `refund-request:${requestId}`,
          targetMicros,
          deltaMicros,
          mode,
        ],
      );
      payment.netCreditUnits = targetMicros;
      payment.pendingRefundCents = input.amount;
      payment.message =
        "A refund to your card is in progress. Your credits have been adjusted.";
      await this.saveDeposit(client, workspaceId, payment, "refund_reserved");
      await this.record(client, {
        workspaceId,
        depositId,
        mode,
        kind: "refund_request",
        actor,
        requestKey: input.requestKey,
        inputHash,
        data: {
          requestId,
          amountCents: input.amount,
          policyVersion: REFUND_POLICY_VERSION,
          note: input.note,
        },
      });
    });
    await this.submit(workspaceId, verified, requestId, input.amount);
    return this.refundQuote(depositId);
  }

  /** Asks Stripe for the refund and records what it answered. */
  private async submit(
    workspaceId: string,
    payment: StripeDeposit,
    requestId: string,
    amountCents: number,
  ) {
    const pool = this.database().pool;
    let failed = false;
    try {
      const refund = await this.stripe.refundAtStripe(
        payment,
        requestId,
        amountCents,
      );
      failed = refund.status === "failed" || refund.status === "canceled";
      await pool.query(
        "UPDATE octolab.wallet_refund_requests SET status=$2, stripe_refund_id=$3, updated_at=now() WHERE id=$1 AND status IN ('reserved','submitted')",
        [requestId, failed ? "failed" : "submitted", refund.id],
      );
    } catch (error) {
      // Only an answer from Stripe that the request was refused is a failure.
      // Anything else (timeout, 5xx, a response we could not read) may still
      // have moved money, so the amount stays reserved.
      const refused =
        error instanceof Stripe.errors.StripeInvalidRequestError ||
        error instanceof Stripe.errors.StripeCardError;
      if (!refused)
        throw new FundingError(
          502,
          "Stripe did not confirm the refund. The amount stays reserved. Resolve this refund to find out what Stripe did.",
        );
      failed = true;
      await pool.query(
        "UPDATE octolab.wallet_refund_requests SET status='failed', updated_at=now() WHERE id=$1 AND status='reserved'",
        [requestId],
      );
    }
    // Converges the balance: a failed request no longer reserves anything, so
    // its credits return; a submitted one stays out until Stripe reports it.
    await this.inAccount(workspaceId, () => this.stripe.reconcile(payment.id));
    await this.settleReported(workspaceId, payment.id);
    if (failed)
      throw new FundingError(
        409,
        "Stripe refused this refund. The credits were returned to the balance.",
      );
  }

  /**
   * Settles a refund whose outcome is unknown, by asking Stripe which refunds
   * exist for the payment. Safe to repeat.
   */
  async resolveRefund(requestId: string, actor: string): Promise<RefundQuote> {
    const pool = this.database().pool;
    const row = (
      await pool.query(
        "SELECT * FROM octolab.wallet_refund_requests WHERE id=$1",
        [requestId],
      )
    ).rows[0];
    if (!row) throw new FundingError(404, "Refund request not found.");
    const workspaceId = String(row.workspace_id);
    const request = requestRow(row);
    if (request.status === "reserved" || request.status === "submitted") {
      const payment = await this.inAccount(workspaceId, () =>
        this.stripe.get(request.depositId),
      );
      const ours = (await this.stripe.refundsFor(payment)).find(
        (r) => r.metadata?.octolab_refund_request_id === requestId,
      );
      const ageMs = this.now() - Date.parse(request.createdAt);
      if (!ours && ageMs < 23 * 3600000) {
        // Stripe has no such refund yet and the idempotency key is still
        // valid, so sending the same request again cannot refund twice.
        await this.submit(workspaceId, payment, requestId, request.amountCents);
      } else {
        const status =
          !ours || ours.status === "failed" || ours.status === "canceled"
            ? "failed"
            : "submitted";
        await this.owner(workspaceId, async (client) => {
          const changed = await client.query(
            "UPDATE octolab.wallet_refund_requests SET status=$2, stripe_refund_id=COALESCE($3,stripe_refund_id), updated_at=now() WHERE id=$1 AND status IN ('reserved','submitted') AND status<>$2",
            [requestId, status, ours?.id ?? null],
          );
          if (changed.rowCount)
            await this.record(client, {
              workspaceId,
              depositId: request.depositId,
              mode: row.mode,
              kind: "refund_resolution",
              actor,
              requestKey: randomUUID(),
              inputHash: hash({ requestId, status }),
              data: { requestId, status, stripeRefundId: ours?.id ?? null },
            });
        });
        await this.inAccount(workspaceId, () =>
          this.stripe.reconcile(request.depositId),
        );
        await this.settleReported(workspaceId, request.depositId);
      }
    }
    return this.refundQuote(request.depositId);
  }

  /** Wallet payments across accounts, newest first, for the operator refund screen. */
  async payments(query = "") {
    const q = query.trim().toLowerCase();
    return (
      await this.database().pool.query(
        `SELECT d.body, w.mode, s.name AS account
         FROM octolab.wallet_deposits w
         JOIN octolab.stripe_deposits d ON d.workspace_id=w.workspace_id AND d.id=w.deposit_id
         JOIN octolab.workspaces s ON s.id=w.workspace_id
         WHERE $1='' OR lower(d.id || ' ' || COALESCE(d.payment_intent_id,'') || ' ' ||
                              COALESCE(d.charge_id,'') || ' ' || s.name) LIKE '%' || $1 || '%'
         ORDER BY d.rowid DESC LIMIT 50`,
        [q.replace(/[%_\\]/g, "")],
      )
    ).rows.map((row) => ({
      payment: JSON.parse(row.body) as StripeDeposit,
      mode: row.mode as StripeMode,
      account: String(row.account),
    }));
  }
}
