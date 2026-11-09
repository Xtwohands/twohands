import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { Accounts, AccountError, type VerifiedIdentity } from "./accounts.js";
import { ApiKeyError, requiredApiKeyScope } from "./api-keys.js";
import type { Store } from "./store.js";
export function sameOriginWrite(req: Request, res: Response): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  try {
    const origin = req.header("origin");
    if (origin && new URL(origin).host !== req.headers.host) throw new Error();
  } catch {
    res.status(403).json({ error: "Cross-origin writes are not allowed" });
    return false;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "JSON content type required" });
    return false;
  }
  return true;
}
export function accountFailure(error: unknown, res: Response) {
  if (error instanceof AccountError || error instanceof ApiKeyError)
    res.status(error.status).json({ error: error.message });
  else if (error instanceof z.ZodError)
    res
      .status(400)
      .json({ error: error.issues.map((i) => i.message).join("; ") });
  else
    res.status(503).json({
      error: "Account access could not be verified. Try again shortly.",
    });
}
export function accountRoutes(app: Express, accounts?: Accounts) {
  app.get("/api/auth/config", (_req, res) =>
    res.json(accounts?.publicConfig() ?? { enabled: false }),
  );
  if (!accounts) return;
  const router = express.Router();
  router.use(async (req, res, next) => {
    try {
      if (!sameOriginWrite(req, res)) return;
      res.locals.account = await accounts.identity(req);
      next();
    } catch (error) {
      accountFailure(error, res);
    }
  });
  router.use(express.json({ limit: "12kb" }));
  router.get("/me", async (_req, res) => {
    try {
      res.json(await accounts.profile(res.locals.account));
    } catch (error) {
      accountFailure(error, res);
    }
  });
  router.post("/workspaces", async (req, res) => {
    try {
      res
        .status(201)
        .json(await accounts.createWorkspace(res.locals.account, req.body));
    } catch (error) {
      accountFailure(error, res);
    }
  });
  router.post("/companies", async (req, res) => {
    try {
      res
        .status(201)
        .json(await accounts.companies.register(res.locals.account, req.body));
    } catch (error) {
      accountFailure(error, res);
    }
  });
  app.use("/api/auth", router);
}
export function accountAccess(
  accounts: Accounts,
  store: Store,
  keys: import("./api-keys.js").ApiKeyService,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!sameOriginWrite(req, res)) return;
      const path = normalizedPath(req);
      const credential =
        req.header("authorization")?.replace(/^Bearer /, "") || "";
      if (credential.startsWith("oct_key_")) {
        const workspaceId = await accounts.keyWorkspace(credential);
        await store.scope.run(workspaceId, async () => {
          const key = await keys.authenticate(credential),
            scope = requiredApiKeyScope(req.method, `/api${path}`);
          if (!scope || !key.scopes.includes(scope))
            throw new ApiKeyError(
              403,
              "This API key does not permit this operation.",
            );
          res.locals.apiKeyId = key.id;
          store.actorScope.run({ kind: "api_key", id: key.id }, next);
        });
        return;
      }
      const identity = await accounts.identity(req),
        workspace = await accounts.workspace(
          identity,
          req.header("x-octolab-workspace"),
        );
      if (!accounts.isAdmin(identity.userId) && operatorRestricted(req, path))
        throw new AccountError(
          403,
          "Administrator access is required for this operator action.",
        );
      if (workspace.role === "member" && memberRestricted(req, path))
        throw new AccountError(
          403,
          "Only a workspace owner can change this setting.",
        );
      res.locals.account = identity;
      res.locals.workspaceRole = workspace.role;
      store.scope.run(workspace.id, () =>
        store.actorScope.run({ kind: "account", id: identity.userId }, next),
      );
    } catch (error) {
      accountFailure(error, res);
    }
  };
}
function normalizedPath(req: Request) {
  try {
    return (
      decodeURIComponent(req.path).toLowerCase().replace(/\/+$/, "") || "/"
    );
  } catch {
    throw new AccountError(400, "Invalid request path.");
  }
}
function operatorRestricted(req: Request, path: string) {
  if (
    path.startsWith("/provider-lab") ||
    path.startsWith("/company-insights") ||
    path === "/observations/aggregate"
  )
    return true;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  if (
    path.startsWith("/tasks") ||
    ["/observations", "/observations/proposals"].includes(path)
  )
    return true;
  return /^\/observations\/[^/]+\/(?:approve|evaluate|consent|cases)(?:\/|$)/i.test(
    path,
  );
}
function memberRestricted(req: Request, path: string) {
  if (
    /^\/workspace\/(api-keys|funding)(?:\/|$)/.test(path) ||
    path.startsWith("/provider-lab")
  )
    return true;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  return !requiredApiKeyScope(req.method, `/api${path}`);
}
export function adminAccountAccess(accounts: Accounts, store: Store) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!sameOriginWrite(req, res)) return;
      const identity: VerifiedIdentity = await accounts.identity(req);
      if (!accounts.isAdmin(identity.userId))
        throw new AccountError(
          403,
          "Administrator access is required for payment review.",
        );
      const workspace = await accounts.workspace(
        identity,
        req.header("x-octolab-workspace"),
      );
      res.locals.adminActor = `account ${identity.userId}`;
      store.scope.run(workspace.id, () =>
        store.actorScope.run({ kind: "account", id: identity.userId }, next),
      );
    } catch (error) {
      accountFailure(error, res);
    }
  };
}

/** Company and global admin operations require account identity, never a consumer workspace or machine key. */
export function companyAccountRoutes(app: Express, accounts?: Accounts) {
  if (!accounts) return;
  const router = express.Router();
  router.use(async (req, res, next) => {
    if (!/^\/(?:companies|admin\/companies)(?:\/|$)/i.test(req.path)) {
      next("router");
      return;
    }
    try {
      if (!sameOriginWrite(req, res)) return;
      res.locals.account = await accounts.identity(req);
      next();
    } catch (error) {
      accountFailure(error, res);
    }
  });
  router.use(express.json({ limit: "12kb" }));
  const route =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error) {
        accountFailure(error, res);
      }
    };
  router.get(
    "/companies/:id",
    route(async (req, res) =>
      res.json(
        await accounts.companies.get(res.locals.account, String(req.params.id)),
      ),
    ),
  );
  router.post(
    "/companies/:id/resubmit",
    route(async (req, res) =>
      res.json(
        await accounts.companies.resubmit(
          res.locals.account,
          String(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  router.get(
    "/companies/:id/insights",
    route(async (req, res) =>
      res.json(
        await accounts.companies.insights(
          res.locals.account,
          String(req.params.id),
        ),
      ),
    ),
  );
  router.get(
    "/admin/companies",
    route(async (req, res) =>
      res.json(await accounts.companies.queue(res.locals.account, req.query)),
    ),
  );
  router.get(
    "/admin/companies/:id/history",
    route(async (req, res) =>
      res.json(
        await accounts.companies.history(
          res.locals.account,
          String(req.params.id),
        ),
      ),
    ),
  );
  router.post(
    "/admin/companies/:id/review",
    route(async (req, res) =>
      res.json(
        await accounts.companies.review(
          res.locals.account,
          String(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  app.use("/api", router);
}
