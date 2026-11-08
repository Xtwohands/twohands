import type { Express, Request, Response } from "express";
import { config } from "./config.js";
import { z } from "zod";
import { ApiKeyService, ApiKeyError } from "./api-keys.js";
import { API_KEY_SCOPES, API_KEY_TOOLS } from "./api-key-types.js";
export function apiKeyRoutes(app: Express, keys: ApiKeyService) {
  const handle =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response) => {
      try {
        if (res.locals.apiKeyId)
          throw new ApiKeyError(
            403,
            "Only the workspace owner can manage API keys.",
          );
        if (req.method !== "GET" && config.token.length < 24)
          throw new ApiKeyError(
            503,
            "Configure a workspace owner token of at least 24 characters before issuing API keys.",
          );
        fn(req, res);
      } catch (e) {
        if (e instanceof z.ZodError)
          res
            .status(400)
            .json({ error: e.issues.map((i) => i.message).join("; ") });
        else if (e instanceof ApiKeyError)
          res.status(e.status).json({ error: e.message });
        else
          res.status(500).json({
            error:
              "API key operation failed. Refresh the key list before retrying.",
          });
      }
    };
  app.get(
    "/api/workspace/api-keys",
    handle((_req, res) =>
      res.json({
        enabled: config.token.length >= 24,
        unavailableReason:
          config.token.length < 24
            ? "Protect this workspace with an owner access token before issuing agent keys."
            : null,
        workspaceId: keys.workspaceId,
        keys: keys.list(),
        scopes: API_KEY_SCOPES,
        tools: API_KEY_TOOLS,
        accountModel: "local_shared_workspace",
        limitBasis: "configured_provider_estimates",
      }),
    ),
  );
  app.post(
    "/api/workspace/api-keys",
    handle((req, res) => res.status(201).json(keys.create(req.body))),
  );
  app.get(
    "/api/workspace/api-keys/:id",
    handle((req, res) => {
      const id = z.uuid().parse(req.params.id);
      res.json({ key: keys.get(id), events: keys.events(id) });
    }),
  );
  app.post(
    "/api/workspace/api-keys/:id",
    handle((req, res) =>
      res.json(keys.update(z.uuid().parse(req.params.id), req.body)),
    ),
  );
  app.post(
    "/api/workspace/api-keys/:id/revoke",
    handle((req, res) =>
      res.json(keys.revoke(z.uuid().parse(req.params.id), req.body)),
    ),
  );
}
