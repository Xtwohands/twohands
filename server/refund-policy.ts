/**
 * Refund policy for unused prepaid credits.
 *
 * THE POLICY IS NOT DECIDED. Everything an owner decision would change lives
 * in this file: whether operator refunds may run at all, how much of a
 * payment counts as unused, and the terms shown to customers. The refund
 * mechanism (reserve, Stripe refund, reconciliation, audit) does not change
 * when these do.
 */

/** Recorded on every refund request so a later policy change stays traceable. */
export const REFUND_POLICY_VERSION = "placeholder-unused-balance-v0";

/**
 * Shown on Credits beside real-money top-ups. It is a placeholder: it states
 * only what the system does today and promises no refund.
 */
export const REFUND_TERMS =
  "Refund terms are being finalized. Until they are published, contact Two Hands support about unused credits. Any refund is returned to the card that paid for them.";

/**
 * Operator refunds are off until the owner approves a policy and sets
 * `TWO_HANDS_UNUSED_REFUNDS=true`. Quotes stay available so the numbers can
 * be reviewed first.
 */
export function unusedRefundsEnabled() {
  return process.env.TWO_HANDS_UNUSED_REFUNDS === "true";
}

export interface RefundablePayment {
  id: string;
  createdAt: string;
  /** Verified payment less refunds already made or in flight, in cents. */
  remainingCents: number;
  /** A disputed payment is never refunded from here. */
  disputed: boolean;
}

/**
 * Placeholder policy: the refundable amount is the account's available
 * credit (posted balance less holds for calls in progress), in whole cents.
 * Usage is treated as spending the oldest payments first, so unused credit is
 * attributed to the newest payments first. No fee is deducted and there is no
 * time limit. A frozen balance refunds nothing.
 */
export function refundableByPayment(input: {
  availableMicros: number;
  frozen: boolean;
  payments: RefundablePayment[];
}): Map<string, number> {
  const result = new Map<string, number>();
  let unused = input.frozen
    ? 0
    : Math.max(0, Math.floor(input.availableMicros / 10_000));
  const newestFirst = [...input.payments].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  for (const payment of newestFirst) {
    const cents = payment.disputed
      ? 0
      : Math.max(0, Math.min(unused, payment.remainingCents));
    result.set(payment.id, cents);
    unused -= cents;
  }
  return result;
}
