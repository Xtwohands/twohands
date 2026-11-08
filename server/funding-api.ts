import type { Express, Request, Response } from "express";
import { z } from "zod";
import { FundingError, FundingService } from "./funding.js";
export function fundingRoutes(app: Express, service: FundingService) {
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
          res
            .status(500)
            .json({
              error: "Deposit operation failed. No automatic retry was made.",
            });
      }
    };
  app.get(
    "/api/workspace/funding",
    route((_req, res) => res.json(service.summary())),
  );
  app.post(
    "/api/workspace/funding/deposits",
    route((req, res) => res.status(201).json(service.create(req.body))),
  );
  app.get(
    "/api/workspace/funding/deposits/:id",
    route((req, res) => res.json(service.get(z.uuid().parse(req.params.id)))),
  );
  app.post(
    "/api/workspace/funding/deposits/:id/verify",
    route(async (req, res) =>
      res.json(await service.verify(z.uuid().parse(req.params.id), req.body)),
    ),
  );
}
