import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { z } from "zod";
import { Companies } from "./companies.js";
import { PostgresDatabase } from "./database.js";
import type { Store } from "./store.js";
import type {
  AccountProfile,
  AccountWorkspace,
  AuthPublicConfig,
} from "./account-types.js";
export class AccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface VerifiedIdentity {
  userId: string;
  email: string;
  sessionId: string;
  expiresAt: number;
}
export type IdentityVerifier = (token: string) => Promise<VerifiedIdentity>;
export interface AccountSettings {
  url: string;
  publishableKey: string;
  adminUserIds: string[];
}
export function accountSettings(): AccountSettings {
  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
    publishableKey:
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      "",
    adminUserIds: (process.env.SUPABASE_ADMIN_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
export function supabaseVerifier(settings: AccountSettings): IdentityVerifier {
  const client = createClient(settings.url, settings.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        }),
    },
  });
  return async (token) => {
    const { data, error } = await client.auth.getUser(token);
    if (error) {
      if (!error.status || error.status >= 500 || error.status === 429)
        throw new AccountError(
          503,
          "The sign-in service is temporarily unavailable. Try again shortly.",
        );
      throw new AccountError(401, "Invalid account session. Sign in again.");
    }
    if (
      !data.user ||
      data.user.is_anonymous ||
      !data.user.email ||
      !data.user.email_confirmed_at
    )
      throw new AccountError(401, "Sign in with a verified email account.");
    // The Auth service verified this JWT. Its claims are only used to bind the live session below.
    let claims: unknown;
    try {
      claims = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      );
    } catch {
      throw new AccountError(401, "Invalid account session.");
    }
    const value = z
      .object({
        sub: z.uuid(),
        session_id: z.uuid(),
        exp: z.number().int().positive(),
      })
      .safeParse(claims);
    if (
      !value.success ||
      value.data.sub !== data.user.id ||
      value.data.exp * 1000 <= Date.now()
    )
      throw new AccountError(401, "Account session expired. Sign in again.");
    return {
      userId: data.user.id,
      email: data.user.email,
      sessionId: value.data.session_id,
      expiresAt: value.data.exp * 1000,
    };
  };
}
export class Accounts {
  readonly previewScope = new AsyncLocalStorage<"user" | "company">();
  readonly companies = new Companies(this);
  readonly database: PostgresDatabase;
  private cache = new Map<
    string,
    { identity: VerifiedIdentity; until: number }
  >();
  private pending = new Map<string, Promise<VerifiedIdentity>>();
  private verify: IdentityVerifier;
  constructor(
    readonly store: Store,
    readonly settings = accountSettings(),
    verify?: IdentityVerifier,
  ) {
    if (!(store.db instanceof PostgresDatabase))
      throw new Error("Account authentication requires PostgreSQL storage.");
    this.database = store.db;
    let url: URL;
    try {
      url = new URL(settings.url);
    } catch {
      throw new Error(
        "Configure the Supabase project API URL and publishable key.",
      );
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
    )
      throw new Error(
        "Set SUPABASE_URL to the hosted project's HTTPS API origin.",
      );
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(settings.publishableKey))
      throw new Error(
        "Use a Supabase publishable key. Secret/service-role keys are not accepted.",
      );
    settings.adminUserIds.forEach((id) => z.uuid().parse(id));
    this.verify = verify ?? supabaseVerifier(settings);
  }
  publicConfig(): AuthPublicConfig {
    return {
      enabled: true,
      url: this.settings.url,
      publishableKey: this.settings.publishableKey,
    };
  }
  isAdmin(userId: string) {
    return (
      !this.previewScope.getStore() &&
      this.settings.adminUserIds.includes(userId)
    );
  }
  async identity(req: Request): Promise<VerifiedIdentity> {
    const token = req.header("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || token.length > 8192 || token.startsWith("oct_key_"))
      throw new AccountError(401, "Sign in to access this workspace.");
    const key = createHash("sha256").update(token).digest("hex");
    const cached = this.cache.get(key);
    let identity: VerifiedIdentity;
    if (cached && cached.until > Date.now()) identity = cached.identity;
    else {
      let work = this.pending.get(key);
      if (!work) {
        if (this.pending.size >= 20)
          throw new AccountError(
            503,
            "Account verification is busy. Try again shortly.",
          );
        work = this.verify(token);
        this.pending.set(key, work);
      }
      try {
        identity = await work;
        if (this.cache.size >= 1000)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          identity,
          until: Math.min(identity.expiresAt, Date.now() + 15000),
        });
      } finally {
        if (this.pending.get(key) === work) this.pending.delete(key);
      }
    }
    if (identity.expiresAt <= Date.now())
      throw new AccountError(401, "Account session expired. Sign in again.");
    // Session revocation, deletion and bans take effect even while a verified identity is cached.
    const active = await this.database.pool.query(
      `SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND (s.not_after IS NULL OR s.not_after>now())
      AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())`,
      [identity.sessionId, identity.userId],
    );
    if (!active.rowCount) {
      this.cache.delete(key);
      throw new AccountError(
        401,
        "This account session has ended. Sign in again.",
      );
    }
    return identity;
  }
  async profile(identity: VerifiedIdentity): Promise<AccountProfile> {
    const result = this.isAdmin(identity.userId)
      ? await this.database.pool.query(
          "SELECT id,name,'platform_admin' AS role FROM octolab.workspaces ORDER BY created_at,id LIMIT 1000",
        )
      : await this.database.pool.query(
          "SELECT w.id,w.name,m.role FROM octolab.workspace_memberships m JOIN octolab.workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.created_at,w.id LIMIT 1000",
          [identity.userId],
        );
    return {
      user: { id: identity.userId, email: identity.email },
      workspaces: result.rows,
      isAdmin: this.isAdmin(identity.userId),
      canPreview: this.settings.adminUserIds.includes(identity.userId),
      companies: await this.companies.list(identity),
    };
  }
  async workspace(
    identity: VerifiedIdentity,
    requested?: string,
  ): Promise<AccountWorkspace> {
    const profile = await this.profile(identity);
    const value = requested
      ? profile.workspaces.find((w) => w.id === requested)
      : profile.workspaces[0];
    if (!value)
      throw new AccountError(
        403,
        requested
          ? "You do not have access to this workspace."
          : "Create a workspace to continue.",
      );
    return value;
  }
  async keyWorkspace(secret: string): Promise<string> {
    if (!/^oct_key_[A-Za-z0-9_-]{43}$/.test(secret))
      throw new AccountError(401, "Invalid API key.");
    const row = await this.database.pool.query(
      "SELECT workspace_id FROM octolab.workspace_api_keys WHERE secret_hash=$1",
      [createHash("sha256").update(secret).digest("hex")],
    );
    if (!row.rowCount) throw new AccountError(401, "Invalid API key.");
    return String(row.rows[0].workspace_id);
  }
  async paymentWorkspace(
    identity: import("./stripe-funding.js").WebhookIdentity,
  ) {
    const result = await this.database.pool.query(
      "SELECT workspace_id FROM octolab.stripe_deposits WHERE id=$1 OR session_id=$2 OR payment_intent_id=$3 OR charge_id=$4 UNION SELECT workspace_id FROM octolab.stripe_webhook_receipts WHERE id=$5",
      [
        identity.depositId,
        identity.sessionId,
        identity.paymentId,
        identity.chargeId,
        identity.eventId,
      ],
    );
    if (result.rows.length > 1)
      throw new AccountError(
        409,
        "Payment identifiers conflict across workspaces. Event processing was stopped.",
      );
    return result.rows[0]?.workspace_id as string | undefined;
  }
  async createWorkspace(
    identity: VerifiedIdentity,
    raw: unknown,
  ): Promise<AccountWorkspace> {
    const input = z
      .object({ name: z.string().trim().min(2).max(80), requestKey: z.uuid() })
      .strict()
      .parse(raw);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["account:" + identity.userId],
      );
      const old = await client.query(
        "SELECT workspace_id,name FROM octolab.workspace_creation_requests WHERE user_id=$1 AND request_key=$2",
        [identity.userId, input.requestKey],
      );
      if (old.rowCount) {
        if (old.rows[0].name !== input.name)
          throw new AccountError(
            409,
            "This workspace request was already used with a different name.",
          );
        const member = await client.query(
          "SELECT role FROM octolab.workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
          [old.rows[0].workspace_id, identity.userId],
        );
        if (!member.rowCount)
          throw new AccountError(
            403,
            "You no longer have access to that workspace.",
          );
        await client.query("COMMIT");
        return {
          id: old.rows[0].workspace_id,
          name: old.rows[0].name,
          role: member.rows[0].role,
        };
      }
      const count = await client.query(
        "SELECT count(*)::integer AS n FROM octolab.workspace_memberships WHERE user_id=$1",
        [identity.userId],
      );
      if (count.rows[0].n >= 10)
        throw new AccountError(409, "Account workspace limit reached.");
      const id = randomUUID();
      await client.query(
        "INSERT INTO octolab.workspaces(id,name) VALUES($1,$2)",
        [id, input.name],
      );
      await client.query(
        "INSERT INTO octolab.workspace_memberships VALUES($1,$2,'owner')",
        [id, identity.userId],
      );
      await client.query(
        "INSERT INTO octolab.workspace_creation_requests VALUES($1,$2,$3,$4)",
        [identity.userId, input.requestKey, id, input.name],
      );
      await client.query(
        "INSERT INTO octolab.account_audit_events(id,workspace_id,actor_user_id,type,data) VALUES($1,$2,$3,'workspace_created',$4)",
        [
          randomUUID(),
          id,
          identity.userId,
          JSON.stringify({ name: input.name }),
        ],
      );
      await client.query("COMMIT");
      return { id, name: input.name, role: "owner" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
