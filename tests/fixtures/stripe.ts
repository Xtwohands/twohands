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
export class FixtureStripeGateway implements StripeGateway {
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
    const id = `cs_test_fixture_${randomUUID().replaceAll("-", "")}`;
    const value = {
      id,
      object: "checkout.session",
      livemode: false,
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
  pay(id: string, refundedCents = 0, disputed = false) {
    const value = this.sessions.get(id);
    if (!value) throw new Error("Unknown fixture checkout");
    const suffix = id.replace("cs_test_", "");
    Object.assign(value, {
      status: "complete",
      payment_status: "paid",
      url: null,
      payment_intent: {
        id: `pi_${suffix}`,
        livemode: false,
        status: "succeeded",
        amount: value.amount_total,
        amount_received: value.amount_total,
        currency: "usd",
        latest_charge: {
          id: `ch_${suffix}`,
          livemode: false,
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
        livemode: false,
        type,
        data: { object },
        ...extra,
      }),
    );
    const signature = this.sdk.webhooks.generateTestHeaderString({
      payload: payload.toString(),
      secret: fixtureStripeSettings.webhookSecret,
    });
    return { payload, signature, id };
  }
}
