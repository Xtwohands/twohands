import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { FundingError, FundingService } from "./funding.js";
import { StripeFundingService } from "./stripe-funding.js";
export function stripeWebhookRoute(app: Express, stripe: StripeFundingService) {
  // This exact endpoint uses Stripe signatures instead of the account credential.
  // It must precede all JSON parsing so signature verification receives original bytes.
  app.post(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "512kb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res
          .status(415)
          .json({ error: "Stripe webhook requires a JSON request body." });
        return;
      }
      const signature = req.header("stripe-signature");
      if (!signature) {
        res.status(400).json({ error: "Missing Stripe webhook signature." });
        return;
      }
      try {
        res.json(await stripe.webhook(req.body, signature));
      } catch (error) {
        res.status(error instanceof FundingError ? error.status : 500).json({
          error:
            error instanceof FundingError
              ? error.message
              : "Stripe event processing failed. Retry delivery.",
        });
      }
    },
  );
}
export function fundingRoutes(
  app: Express,
  service: FundingService,
  stripe: StripeFundingService,
) {
  const route =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: error.issues.map((i) => i.message).join("; ") });
        else if (error instanceof FundingError)
          res.status(error.status).json({ error: error.message });
        else
          res.status(500).json({
            error: "Deposit operation failed. No automatic retry was made.",
          });
      }
    };
  app.get(
    "/api/account/funding",
    route(async (_req, res) => {
      const summary = await service.summary();
      const stripeDeposits = Number(
        (await service.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM stripe_deposits WHERE payment_intent_id IS NOT NULL",
          )
          .get())!.n,
      );
      res.json({
        ...summary,
        ...(await stripe.summary()),
        stripeDeposits,
        totalDeposits: summary.totalDeposits + stripeDeposits,
      });
    }),
  );
  app.post(
    "/api/account/funding/deposits",
    route(async (req, res) =>
      res.status(201).json(await service.create(req.body)),
    ),
  );
  app.post(
    "/api/account/funding/stripe",
    route(async (req, res) =>
      res.status(201).json(await stripe.create(req.body)),
    ),
  );
  app.get(
    "/api/account/funding/stripe/:id",
    route(async (req, res) =>
      res.json(await stripe.get(z.uuid().parse(req.params.id))),
    ),
  );
  app.post(
    "/api/account/funding/stripe/:id/reconcile",
    route(async (req, res) => {
      z.object({}).strict().parse(req.body);
      res.json(await stripe.reconcile(z.uuid().parse(req.params.id), true));
    }),
  );
  app.get(
    "/api/account/funding/deposits/:id",
    route(async (req, res) =>
      res.json(await service.get(z.uuid().parse(req.params.id))),
    ),
  );
  app.post(
    "/api/account/funding/deposits/:id/verify",
    route(async (req, res) =>
      res.json(await service.verify(z.uuid().parse(req.params.id), req.body)),
    ),
  );
}
