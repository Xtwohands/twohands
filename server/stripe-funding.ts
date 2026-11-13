import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import { FundingError, type FundingService } from "./funding.js";
import type { StripeDeposit, StripeFundingStatus } from "./funding-types.js";
export type StripeSettings = {
  enabled: boolean;
  secretKey: string;
  webhookSecret: string;
  appUrl: string;
};
export function stripeSettings(): StripeSettings {
  return {
    enabled: process.env.STRIPE_TEST_ENABLED === "true",
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    appUrl: process.env.PUBLIC_APP_URL || "http://127.0.0.1:5173",
  };
}
export function appOrigin(value: string) {
  try {
    const u = new URL(value);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
        ))
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}
export interface StripeGateway {
  create(
    params: Stripe.Checkout.SessionCreateParams,
    key: string,
  ): Promise<unknown>;
  retrieve(id: string): Promise<unknown>;
  payment(id: string): Promise<unknown>;
  event(payload: Buffer, signature: string, secret: string): Stripe.Event;
}
export function stripeGateway(settings: StripeSettings): StripeGateway {
  const client = new Stripe(settings.secretKey || "sk_test_unconfigured", {
    timeout: 15000,
    maxNetworkRetries: 1,
  });
  return {
    create: (params, key) =>
      client.checkout.sessions.create(params, { idempotencyKey: key }),
    retrieve: (id) =>
      client.checkout.sessions.retrieve(id, {
        expand: ["payment_intent.latest_charge"],
      }),
    payment: (id) => client.paymentIntents.retrieve(id),
    event: (payload, signature, secret) =>
      client.webhooks.constructEvent(payload, signature, secret),
  };
}
export const stripeDepositInput = z
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
      .pipe(
        z
          .number()
          .int()
          .min(500, "Minimum card deposit is $5 in test mode.")
          .max(100000, "Maximum card deposit is $1,000 in test mode."),
      ),
  })
  .strict();
const metadata = z.record(z.string(), z.string()).nullable();
const sessionSchema = z.object({
  id: z.string().startsWith("cs_test_"),
  livemode: z.literal(false),
  mode: z.literal("payment"),
  amount_total: z.number().int(),
  currency: z.string(),
  client_reference_id: z.string().nullable(),
  metadata,
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  url: z.string().nullable().optional(),
  payment_intent: z.unknown().optional(),
});
const paymentSchema = z.object({
  id: z.string().startsWith("pi_"),
  livemode: z.literal(false),
  status: z.literal("succeeded"),
  amount: z.number().int(),
  amount_received: z.number().int(),
  currency: z.literal("usd"),
  latest_charge: z.object({
    id: z.string().startsWith("ch_"),
    livemode: z.literal(false),
    paid: z.literal(true),
    captured: z.literal(true),
    amount: z.number().int(),
    amount_captured: z.number().int(),
    currency: z.literal("usd"),
    amount_refunded: z.number().int().min(0),
    disputed: z.boolean(),
  }),
});
const EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);
export interface WebhookIdentity {
  eventId: string;
  depositId: string;
  sessionId: string;
  paymentId: string;
  chargeId: string;
}
export class StripeFundingService {
  workspaceForWebhook?: (
    identity: WebhookIdentity,
  ) => Promise<string | undefined>;
  readonly active = new Map<string, Promise<StripeDeposit>>();
  readonly creating = new Map<string, Promise<StripeDeposit>>();
  private manualChecks = new Map<string, number>();
  constructor(
    public funding: FundingService,
    public settings = stripeSettings(),
    private gateway = stripeGateway(settings),
    private now = () => Date.now(),
  ) {}
  status(): StripeFundingStatus {
    const reason = !this.settings.enabled
      ? "Stripe test deposits are not enabled on this server."
      : !/^sk_test_|^rk_test_/.test(this.settings.secretKey)
        ? "Configure a Stripe test secret key on the server. Live keys are not supported."
        : !this.settings.webhookSecret.startsWith("whsec_")
          ? "Configure the Stripe webhook signing secret on the server."
          : !appOrigin(this.settings.appUrl)
            ? "Configure a valid PUBLIC_APP_URL on the server."
            : null;
    return {
      enabled: !reason,
      unavailableReason: reason,
      mode: "test",
      minimumCents: 500,
      maximumCents: 100000,
    };
  }
  private ensureConfigured() {
    if (
      !/^sk_test_|^rk_test_/.test(this.settings.secretKey) ||
      !this.settings.webhookSecret.startsWith("whsec_") ||
      !appOrigin(this.settings.appUrl)
    )
      throw new FundingError(
        409,
        "Stripe test verification is not configured. No credits were added.",
      );
  }
  async get(id: string): Promise<StripeDeposit> {
    const row = await this.funding.store.db
      .prepare("SELECT body FROM stripe_deposits WHERE id=?")
      .get(id);
    if (!row) throw new FundingError(404, "Card deposit not found.");
    return JSON.parse(row.body as string);
  }
  async list(): Promise<StripeDeposit[]> {
    return (
      await this.funding.store.db
        .prepare(
          "SELECT body FROM stripe_deposits ORDER BY rowid DESC LIMIT 100",
        )
        .all()
    ).map((r) => JSON.parse(r.body as string));
  }
  private async save(value: StripeDeposit, event: string) {
    value.updatedAt = new Date(this.now()).toISOString();
    await this.funding.store.db
      .prepare(
        "UPDATE stripe_deposits SET session_id=?,payment_intent_id=?,charge_id=?,body=? WHERE id=?",
      )
      .run(
        value.checkoutSessionId,
        value.paymentIntentId,
        value.chargeId,
        JSON.stringify(value),
        value.id,
      );
    await this.funding.store.db
      .prepare(
        "INSERT INTO stripe_deposit_events(deposit_id,body) VALUES (?,?)",
      )
      .run(
        value.id,
        JSON.stringify({
          event,
          at: value.updatedAt,
          status: value.status,
          sessionId: value.checkoutSessionId,
          paymentIntentId: value.paymentIntentId,
          chargeId: value.chargeId,
          amountCents: value.amountCents,
          refundedCents: value.refundedCents,
          netCreditUnits: value.netCreditUnits,
        }),
      );
    return value;
  }
  async create(raw: unknown): Promise<StripeDeposit> {
    const input = stripeDepositInput.parse(raw);
    const value = await this.funding.store.transaction(async () => {
      const existing = await this.funding.store.db
        .prepare("SELECT id FROM stripe_deposits WHERE request_key=?")
        .get(input.requestKey);
      let value: StripeDeposit;
      if (existing) {
        value = await this.get(existing.id as string);
        if (value.amountCents !== input.amount)
          throw new FundingError(
            409,
            "This request key was already used with a different amount.",
          );
        if (value.checkoutSessionId) return value;
        if (this.now() - Date.parse(value.createdAt) > 23 * 3600000)
          throw new FundingError(
            409,
            "This checkout needs reconciliation before it can be retried. Its original request key will not be reused with new payment details.",
          );
      } else {
        const status = this.status();
        if (!status.enabled)
          throw new FundingError(409, status.unavailableReason!);
        const at = new Date(this.now()).toISOString();
        value = {
          id: randomUUID(),
          requestKey: input.requestKey,
          amountCents: input.amount,
          status: "creating",
          checkoutSessionId: null,
          checkoutUrl: null,
          paymentIntentId: null,
          chargeId: null,
          refundedCents: 0,
          disputed: false,
          netCreditUnits: 0,
          createdAt: at,
          updatedAt: at,
          lastCheckedAt: null,
          message: "Preparing Stripe Checkout.",
        };
        {
          if (
            Number(
              (await this.funding.store.db
                .prepare("SELECT COUNT(*) AS n FROM stripe_deposits")
                .get())!.n,
            ) >= 1000
          )
            throw new FundingError(
              409,
              "Your account has reached its card deposit limit.",
            );
          await this.funding.store.db
            .prepare(
              "INSERT INTO stripe_deposits VALUES (?,?,NULL,NULL,NULL,?)",
            )
            .run(value.id, input.requestKey, JSON.stringify(value));
          await this.save(value, "checkout_requested");
        }
      }
      if (!this.status().enabled)
        throw new FundingError(409, this.status().unavailableReason!);
      return value;
    });
    if (value.checkoutSessionId) return value;
    const pending = this.creating.get(value.id);
    if (pending) return pending;
    const promise = this.createCheckout(value);
    this.creating.set(value.id, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(value.id);
    }
  }
  private async createCheckout(value: StripeDeposit): Promise<StripeDeposit> {
    try {
      const origin = appOrigin(this.settings.appUrl)!;
      const raw = await this.gateway.create(
        {
          mode: "payment",
          allowed_payment_method_types: ["card"],
          client_reference_id: value.id,
          metadata: { octolab_deposit_id: value.id },
          payment_intent_data: { metadata: { octolab_deposit_id: value.id } },
          success_url: `${origin}/?stripe_deposit=${value.id}#dashboard/credits`,
          cancel_url: `${origin}/?stripe_deposit=${value.id}&stripe_cancelled=1#dashboard/credits`,
          expires_at:
            Math.floor(Date.parse(value.createdAt) / 1000) + 24 * 3600,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: value.amountCents,
                product_data: {
                  name: "octolab test credits",
                  description:
                    "Sandbox funding only. Test credits do not pay for live provider calls.",
                },
              },
            },
          ],
        },
        `octolab-deposit-${value.id}`,
      );
      const session = this.validSession(raw, value);
      if (!session.url) throw new Error("Missing checkout URL");
      const url = new URL(session.url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "checkout.stripe.com" ||
        url.username ||
        url.password
      )
        throw new Error("Invalid checkout URL");
      return await this.funding.store.transaction(async () => {
        const current = await this.get(value.id);
        if (
          current.checkoutSessionId &&
          current.checkoutSessionId !== session.id
        )
          throw new FundingError(409, "Conflicting Stripe checkout receipt.");
        if (current.status !== "creating" && current.status !== "failed")
          return current;
        current.checkoutSessionId = session.id;
        current.checkoutUrl = session.url!;
        current.status = "checkout_ready";
        current.message = "Continue to Stripe to complete the test payment.";
        return await this.save(current, "checkout_created");
      });
    } catch (error) {
      const current = await this.get(value.id);
      if (!current.checkoutSessionId)
        await this.funding.store.transaction(async () => {
          current.status = "failed";
          current.message =
            "Checkout could not be prepared. Retry the same deposit request to recover its original checkout.";
          await this.save(current, "checkout_create_failed");
        });
      if (error instanceof FundingError) throw error;
      throw new FundingError(
        502,
        "Stripe Checkout could not be prepared. Retry this request; no credits were added.",
      );
    }
  }
  private validSession(raw: unknown, value: StripeDeposit) {
    const session = sessionSchema.parse(raw);
    if (
      session.amount_total !== value.amountCents ||
      session.currency !== "usd" ||
      session.client_reference_id !== value.id ||
      session.metadata?.octolab_deposit_id !== value.id ||
      (value.checkoutSessionId && session.id !== value.checkoutSessionId)
    )
      throw new FundingError(
        502,
        "Stripe returned payment details that do not match this deposit. No credits were added.",
      );
    return session;
  }
  async reconcile(id: string, manual = false): Promise<StripeDeposit> {
    this.ensureConfigured();
    const existing = this.active.get(id);
    if (existing) return existing;
    if (manual) {
      const last = this.manualChecks.get(id);
      if (last !== undefined && this.now() - last < 10000)
        throw new FundingError(
          429,
          "Wait 10 seconds before checking this payment again.",
        );
      this.manualChecks.set(id, this.now());
    }
    const promise = this.reconcilePayment(id);
    this.active.set(id, promise);
    try {
      return await promise;
    } finally {
      this.active.delete(id);
    }
  }
  private async reconcilePayment(id: string): Promise<StripeDeposit> {
    const value = await this.get(id);
    if (!value.checkoutSessionId)
      throw new FundingError(
        409,
        "Retry this deposit request to recover its Stripe checkout first.",
      );
    try {
      const session = this.validSession(
        await this.gateway.retrieve(value.checkoutSessionId),
        value,
      );
      return await this.funding.store.transaction(async () => {
        const current = await this.get(id);
        current.lastCheckedAt = new Date(this.now()).toISOString();
        if (
          session.payment_status !== "paid" ||
          session.status !== "complete"
        ) {
          if (current.netCreditUnits || current.paymentIntentId)
            throw new FundingError(
              502,
              "Stripe returned an inconsistent payment state. The saved receipt was retained.",
            );
          current.status =
            session.status === "expired"
              ? "expired"
              : session.status === "complete"
                ? "processing"
                : "checkout_ready";
          current.message =
            current.status === "expired"
              ? "This checkout expired without a verified payment."
              : "Payment has not been confirmed by Stripe yet.";
          return await this.save(current, "payment_pending");
        }
        const payment = paymentSchema.parse(session.payment_intent);
        const charge = payment.latest_charge;
        if (
          payment.amount !== current.amountCents ||
          payment.amount_received !== current.amountCents ||
          charge.amount !== current.amountCents ||
          charge.amount_captured !== current.amountCents ||
          charge.amount_refunded > current.amountCents ||
          (current.paymentIntentId && current.paymentIntentId !== payment.id) ||
          (current.chargeId && current.chargeId !== charge.id)
        )
          throw new FundingError(
            502,
            "Stripe payment amount or identity does not match this deposit. No credits were added.",
          );
        current.paymentIntentId = payment.id;
        current.chargeId = charge.id;
        current.refundedCents = Math.max(
          current.refundedCents,
          charge.amount_refunded,
        );
        current.disputed ||= charge.disputed;
        const target = current.disputed
          ? 0
          : (current.amountCents - current.refundedCents) * 10000;
        const old = await this.funding.ledger.net("stripe", id);
        await this.funding.ledger.settle(
          "stripe",
          id,
          target,
          payment.id,
          current.disputed
            ? "dispute_hold"
            : target < old
              ? "refund"
              : "deposit",
          current.lastCheckedAt!,
        );
        current.netCreditUnits = target;
        current.checkoutUrl = null;
        current.status = current.disputed
          ? "disputed"
          : current.refundedCents === current.amountCents
            ? "refunded"
            : current.refundedCents
              ? "partially_refunded"
              : "credited";
        current.message = current.disputed
          ? "This payment is disputed. Its test credits are held for operator review."
          : current.refundedCents
            ? "Stripe reports a refund. The test-credit balance has been adjusted."
            : "Stripe verified the test payment and added the credits once.";
        return await this.save(current, "payment_reconciled");
      });
    } catch (error) {
      if (error instanceof FundingError) throw error;
      throw new FundingError(
        502,
        "Could not verify this Stripe payment. The saved balance was retained. Try again later.",
      );
    }
  }
  async webhook(payload: Buffer, signature: string) {
    this.ensureConfigured();
    let event: Stripe.Event;
    try {
      event = this.gateway.event(
        payload,
        signature,
        this.settings.webhookSecret,
      );
    } catch {
      throw new FundingError(400, "Invalid Stripe webhook signature.");
    }
    if (event.livemode || !event.id.startsWith("evt_"))
      throw new FundingError(400, "Only Stripe test-mode events are accepted.");
    if (this.workspaceForWebhook) {
      if (!EVENTS.has(event.type)) return { received: true, ignored: true };
      const object = event.data.object as unknown as Record<string, unknown>;
      const identity: WebhookIdentity = {
        eventId: event.id,
        depositId: String(
          (object.metadata as Record<string, string> | undefined)
            ?.octolab_deposit_id || "",
        ),
        sessionId:
          typeof object.id === "string" && object.id.startsWith("cs_test_")
            ? object.id
            : "",
        paymentId:
          typeof object.payment_intent === "string"
            ? object.payment_intent
            : "",
        chargeId:
          typeof object.charge === "string"
            ? object.charge
            : typeof object.id === "string" && object.id.startsWith("ch_")
              ? object.id
              : "",
      };
      let workspace = await this.workspaceForWebhook(identity);
      if (
        !workspace &&
        event.type.startsWith("charge.") &&
        /^pi_/.test(identity.paymentId)
      ) {
        const payment = z
          .object({ id: z.string(), livemode: z.literal(false), metadata })
          .parse(await this.gateway.payment(identity.paymentId));
        if (payment.id !== identity.paymentId)
          throw new FundingError(
            502,
            "Stripe returned a different payment identity.",
          );
        identity.depositId = payment.metadata?.octolab_deposit_id || "";
        workspace = await this.workspaceForWebhook(identity);
      }
      if (!workspace) return { received: true, ignored: true };
      return this.funding.store.scope.run(workspace, () =>
        this.webhookEvent(event),
      );
    }
    return this.webhookEvent(event);
  }
  private async webhookEvent(event: Stripe.Event) {
    if (
      await this.funding.store.db
        .prepare("SELECT id FROM stripe_webhook_receipts WHERE id=?")
        .get(event.id)
    )
      return { received: true, replayed: true };
    if (!EVENTS.has(event.type)) return { received: true, ignored: true };
    const object = event.data.object as unknown as Record<string, unknown>;
    const meta = object.metadata as Record<string, string> | undefined;
    let id = meta?.octolab_deposit_id;
    let row = id
      ? await this.funding.store.db
          .prepare("SELECT id FROM stripe_deposits WHERE id=?")
          .get(id)
      : undefined;
    if (!row) {
      const sessionId =
        typeof object.id === "string" && object.id.startsWith("cs_test_")
          ? object.id
          : "";
      const paymentId =
        typeof object.payment_intent === "string" ? object.payment_intent : "";
      const chargeId =
        typeof object.charge === "string"
          ? object.charge
          : typeof object.id === "string" && object.id.startsWith("ch_")
            ? object.id
            : "";
      row = await this.funding.store.db
        .prepare(
          "SELECT id FROM stripe_deposits WHERE session_id=? OR payment_intent_id=? OR charge_id=?",
        )
        .get(sessionId, paymentId, chargeId);
      // Charge/refund/dispute events can arrive before checkout completion.
      // Resolve our own PaymentIntent metadata, then still verify the saved
      // Checkout Session before changing any credits or acknowledging the event.
      if (!row && event.type.startsWith("charge.") && /^pi_/.test(paymentId)) {
        const payment = z
          .object({
            id: z.string(),
            livemode: z.literal(false),
            metadata,
          })
          .parse(await this.gateway.payment(paymentId));
        if (payment.id !== paymentId)
          throw new FundingError(
            502,
            "Stripe returned a different payment identity.",
          );
        const depositId = payment.metadata?.octolab_deposit_id;
        if (depositId)
          row = await this.funding.store.db
            .prepare("SELECT id FROM stripe_deposits WHERE id=?")
            .get(depositId);
      }
    }
    if (!row) return { received: true, ignored: true };
    id = String(row.id);
    // Checkout can finish before the create response is saved. Recover only its own signed session identity.
    if (
      !(await this.get(id)).checkoutSessionId &&
      event.type.startsWith("checkout.session.")
    ) {
      const session = this.validSession(object, await this.get(id));
      await this.funding.store.transaction(async () => {
        const current = await this.get(id!);
        current.checkoutSessionId = session.id;
        await this.save(current, "checkout_recovered_from_webhook");
      });
    }
    // A read already in flight may predate this event (for example, a refund).
    // Wait for it, then initiate/join a read that starts after this event arrived.
    // Never acknowledge a new event solely on an older in-flight snapshot.
    const earlierRead = this.active.get(id);
    if (earlierRead) {
      try {
        await earlierRead;
      } catch {
        // This delivery still gets its own verification attempt below.
      }
    }
    await this.reconcile(id);
    await this.funding.store.transaction(
      async () =>
        await this.funding.store.db
          .prepare(
            "INSERT OR IGNORE INTO stripe_webhook_receipts VALUES (?,?,?,?)",
          )
          .run(event.id, event.type, id, new Date(this.now()).toISOString()),
    );
    return { received: true, replayed: false };
  }
  async summary() {
    return {
      stripe: this.status(),
      stripeIntents: await this.list(),
      entries: await this.funding.ledger.entries(),
    };
  }
}
