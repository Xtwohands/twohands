/** Test-process adapter only. Never imported by the production server. */
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import type {
  StripeGateway,
  StripeSettings,
} from "../../server/stripe-funding.js";
export const fixtureStripeSettings: StripeSettings = {
  enabled: true,
  secretKey: "sk_test_fixture_only",
  webhookSecret: "whsec_fixture_only",
  appUrl: "http://127.0.0.1:3102",
};
/** Fixture-only live rail. These are not Stripe credentials and reach no network. */
export const fixtureLiveStripeSettings: StripeSettings = {
  enabled: true,
  secretKey: "sk_live_fixture_only",
  webhookSecret: "whsec_fixture_live_only",
  appUrl: "https://fixture.invalid",
  maximumCents: 10000,
};
export class FixtureStripeGateway implements StripeGateway {
  /** "live" makes this an in-memory stand-in for Stripe live mode. */
  constructor(
    readonly mode: "test" | "live" = "test",
    private secret = mode === "live"
      ? fixtureLiveStripeSettings.webhookSecret
      : fixtureStripeSettings.webhookSecret,
  ) {}
  /** Dispute status Stripe reports per PaymentIntent. */
  readonly disputeStatus = new Map<
    string,
    { status: string; amount?: number }
  >();
  readonly refundCalls: {
    paymentIntentId: string;
    amountCents: number;
    key: string;
  }[] = [];
  readonly issued = new Map<string, any>();
  /** How the next refund request behaves at the fixture. */
  refundBehavior: "succeed" | "refuse" | "lost" | "pending" = "succeed";
  readonly sessions = new Map<string, any>();
  readonly keys = new Map<string, string>();
  readonly creates: {
    params: Stripe.Checkout.SessionCreateParams;
    key: string;
  }[] = [];
  readonly reads: string[] = [];
  private sdk = new Stripe(fixtureStripeSettings.secretKey);
  async create(params: Stripe.Checkout.SessionCreateParams, key: string) {
    this.creates.push({ params: structuredClone(params), key });
    const known = this.keys.get(key);
    if (known) return structuredClone(this.sessions.get(known));
    const id = `cs_${this.mode}_fixture_${randomUUID().replaceAll("-", "")}`;
    const value = {
      id,
      object: "checkout.session",
      livemode: this.mode === "live",
      mode: "payment",
      amount_total: params.line_items![0].price_data!.unit_amount,
      currency: "usd",
      client_reference_id: params.client_reference_id,
      metadata: structuredClone(params.metadata),
      status: "open",
      payment_status: "unpaid",
      url: `https://checkout.stripe.com/c/pay/${id}`,
      payment_intent: null,
    };
    this.keys.set(key, id);
    this.sessions.set(id, value);
    return structuredClone(value);
  }
  async retrieve(id: string) {
    this.reads.push(id);
    if (!this.sessions.has(id)) throw new Error("Unknown fixture checkout");
    return structuredClone(this.sessions.get(id));
  }
  event(payload: Buffer, signature: string, secret: string) {
    return this.sdk.webhooks.constructEvent(payload, signature, secret);
  }
  async payment(id: string) {
    for (const session of this.sessions.values()) {
      if (session.payment_intent?.id === id)
        return structuredClone(session.payment_intent);
    }
    throw new Error("Unknown fixture payment");
  }
  private sessionOf(paymentIntentId: string) {
    for (const session of this.sessions.values())
      if (session.payment_intent?.id === paymentIntentId) return session;
    throw new Error("Unknown fixture payment");
  }
  async disputes(paymentIntentId: string) {
    const session = this.sessionOf(paymentIntentId);
    const dispute = this.disputeStatus.get(paymentIntentId);
    return dispute
      ? [
          {
            id: `dp_fixture_${paymentIntentId}`,
            livemode: this.mode === "live",
            amount: dispute.amount ?? session.amount_total,
            currency: "usd",
            status: dispute.status,
            payment_intent: paymentIntentId,
          },
        ]
      : [];
  }
  async refunds(paymentIntentId: string) {
    return [...this.issued.values()]
      .filter((r) => r.payment_intent === paymentIntentId)
      .map((r) => structuredClone(r));
  }
  async refund(
    params: { paymentIntentId: string; amountCents: number; requestId: string },
    key: string,
  ) {
    this.refundCalls.push({
      paymentIntentId: params.paymentIntentId,
      amountCents: params.amountCents,
      key,
    });
    const known = this.issued.get(key);
    if (known) return structuredClone(known);
    if (this.refundBehavior === "refuse")
      throw new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Fixture refusal",
      });
    const session = this.sessionOf(params.paymentIntentId);
    const pending = this.refundBehavior === "pending";
    const refund = {
      id: `re_fixture_${randomUUID().replaceAll("-", "")}`,
      amount: params.amountCents,
      currency: "usd",
      status: pending ? "pending" : "succeeded",
      payment_intent: params.paymentIntentId,
      metadata: { octolab_refund_request_id: params.requestId },
    };
    this.issued.set(key, refund);
    // Stripe moved the money even when the response never arrives.
    if (!pending)
      session.payment_intent.latest_charge.amount_refunded +=
        params.amountCents;
    if (this.refundBehavior === "lost") throw new Error("Fixture timeout");
    return structuredClone(refund);
  }
  pay(id: string, refundedCents = 0, disputed = false) {
    const value = this.sessions.get(id);
    if (!value) throw new Error("Unknown fixture checkout");
    const suffix = id.replace(/^cs_(test|live)_/, "");
    const livemode = this.mode === "live";
    Object.assign(value, {
      status: "complete",
      payment_status: "paid",
      url: null,
      payment_intent: {
        metadata: structuredClone(value.metadata),
        id: `pi_${suffix}`,
        livemode,
        status: "succeeded",
        amount: value.amount_total,
        amount_received: value.amount_total,
        currency: "usd",
        latest_charge: {
          id: `ch_${suffix}`,
          livemode,
          receipt_url: `https://pay.stripe.com/receipts/fixture/${suffix}`,
          paid: true,
          captured: true,
          amount: value.amount_total,
          amount_captured: value.amount_total,
          currency: "usd",
          amount_refunded: refundedCents,
          disputed,
        },
      },
    });
    return structuredClone(value);
  }
  signed(
    type: string,
    object: unknown,
    id = `evt_${randomUUID().replaceAll("-", "")}`,
    extra = {},
  ) {
    const payload = Buffer.from(
      JSON.stringify({
        id,
        object: "event",
        livemode: this.mode === "live",
        type,
        data: { object },
        ...extra,
      }),
    );
    const signature = this.sdk.webhooks.generateTestHeaderString({
      payload: payload.toString(),
      secret: this.secret,
    });
    return { payload, signature, id };
  }
}
