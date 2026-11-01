import type { Express, Request, Response } from "express";
import { z } from "zod";
import { ObservationError } from "./observation.js";
import type { ProviderLab } from "./provider-lab.js";

export function providerLabRoutes(app: Express, lab: ProviderLab) {
  const route =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response) => {
      try {
        fn(req, res);
      } catch (e) {
        if (e instanceof z.ZodError)
          res
            .status(400)
            .json({ error: e.issues.map((i) => i.message).join("; ") });
        else if (e instanceof ObservationError)
          res.status(e.status).json({ error: e.message });
        else
          res.status(500).json({
            error:
              "Provider lab operation failed. No automatic retry was made.",
          });
      }
    };
  app.get(
    "/api/provider-lab",
    route((_req, res) => res.json(lab.overview())),
  );
  app.post(
    "/api/provider-lab/runs",
    route((req, res) => res.status(202).json(lab.start(req.body))),
  );
  app.get(
    "/api/provider-lab/runs/:id",
    route((req, res) => res.json(lab.get(String(req.params.id)))),
  );
  app.post(
    "/api/provider-lab/runs/:id/stop",
    route((req, res) => {
      z.object({}).strict().parse(req.body);
      res.json(lab.cancel(String(req.params.id)));
    }),
  );
  app.post(
    "/api/provider-lab/runs/:id/calls/:callId/review",
    route((req, res) =>
      res.json(
        lab.review(String(req.params.id), String(req.params.callId), req.body),
      ),
    ),
  );
  app.post(
    "/api/provider-lab/experiments",
    route((req, res) => res.status(201).json(lab.saveExperiment(req.body))),
  );
  app.post(
    "/api/provider-lab/experiments/:id",
    route((req, res) =>
      res.json(lab.saveExperiment(req.body, String(req.params.id))),
    ),
  );
}
