import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import {
  API_KEY_SCOPES,
  API_KEY_TOOLS,
  type ApiKeyEvent,
  type ApiKeyScope,
  type WorkspaceApiKey,
} from "./api-key-types.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class ApiKeyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const dollars = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/,
    "Use a USD limit with up to six decimal places.",
  )
  .transform((value) => {
    const [a, b = ""] = value.split(".");
    return Number(a) * 1e6 + Number(b.padEnd(6, "0"));
  })
  .pipe(z.number().int().min(0).max(1e9));
const settings = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1)
      .max(API_KEY_SCOPES.length)
      .transform((v) => [...new Set(v)].sort()),
    allowedTools: z
      .array(z.enum(API_KEY_TOOLS))
      .min(1)
      .max(3)
      .default([...API_KEY_TOOLS])
      .transform((v) => [...new Set(v)].sort()),
    limitUsd: dollars,
  })
  .strict();
const createInput = settings.extend({
  requestKey: z.uuid(),
  expiresInDays: z
    .union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)])
    .default(30),
});
const updateInput = settings.extend({
  revision: z.number().int().nonnegative(),
});
type KeyBody = Omit<
  WorkspaceApiKey,
  "spentMicros" | "reservedMicros" | "remainingMicros" | "status"
>;
export class ApiKeyService {
  readonly workspaceId: string;
  constructor(
    public store: Store,
    private now = () => Date.now(),
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS api_key_workspace(id INTEGER PRIMARY KEY CHECK(id=1),workspace_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_api_keys(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,secret_hash TEXT NOT NULL UNIQUE,create_request_key TEXT NOT NULL UNIQUE,input_hash TEXT NOT NULL,body TEXT NOT NULL,spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros>=0));
      CREATE TABLE IF NOT EXISTS api_key_spend(call_id TEXT PRIMARY KEY,key_id TEXT NOT NULL REFERENCES workspace_api_keys(id),amount_micros INTEGER NOT NULL CHECK(amount_micros>=0),state TEXT NOT NULL CHECK(state IN ('reserved','settled')),created_at TEXT NOT NULL,settled_at TEXT);
      CREATE TABLE IF NOT EXISTS api_key_events(id TEXT PRIMARY KEY,key_id TEXT NOT NULL REFERENCES workspace_api_keys(id),body TEXT NOT NULL);`);
    store.db
      .prepare("INSERT OR IGNORE INTO api_key_workspace VALUES (1,?)")
      .run(randomUUID());
    this.workspaceId = String(
      store.db
        .prepare("SELECT workspace_id FROM api_key_workspace WHERE id=1")
        .get()!.workspace_id,
    );
  }
  hasIssuedKeys() {
    return !!this.store.db
      .prepare("SELECT 1 FROM workspace_api_keys LIMIT 1")
      .get();
  }
  get(id: string): WorkspaceApiKey {
    const row = this.store.db
      .prepare(
        "SELECT body,spent_micros,reserved_micros FROM workspace_api_keys WHERE id=? AND workspace_id=?",
      )
      .get(id, this.workspaceId);
    if (!row) throw new ApiKeyError(404, "API key not found.");
    const body = JSON.parse(String(row.body)) as KeyBody;
    const spentMicros = Number(row.spent_micros),
      reservedMicros = Number(row.reserved_micros);
    return {
      ...body,
      spentMicros,
      reservedMicros,
      remainingMicros: Math.max(
        0,
        body.limitMicros - spentMicros - reservedMicros,
      ),
      status: body.revokedAt
        ? "revoked"
        : Date.parse(body.expiresAt) <= this.now()
          ? "expired"
          : spentMicros + reservedMicros >= body.limitMicros
            ? "at_limit"
            : "active",
    };
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT id FROM workspace_api_keys WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1000",
      )
      .all(this.workspaceId)
      .map((r) => this.get(String(r.id)));
  }
  active(id: string) {
    const value = this.get(id);
    if (value.revokedAt || Date.parse(value.expiresAt) <= this.now())
      throw new ApiKeyError(401, "This API key is revoked or expired.");
    return value;
  }
  authenticate(secret: string) {
    if (!/^oct_key_[A-Za-z0-9_-]{43}$/.test(secret))
      throw new ApiKeyError(401, "Invalid API key.");
    const row = this.store.db
      .prepare(
        "SELECT id FROM workspace_api_keys WHERE secret_hash=? AND workspace_id=?",
      )
      .get(hash(secret), this.workspaceId);
    if (!row) throw new ApiKeyError(401, "Invalid API key.");
    const value = this.active(String(row.id));
    this.store.db
      .prepare(
        "UPDATE workspace_api_keys SET body=json_set(body,'$.lastUsedAt',?) WHERE id=?",
      )
      .run(new Date(this.now()).toISOString(), value.id);
    return this.get(value.id);
  }
  private audit(
    type: ApiKeyEvent["type"],
    previous: WorkspaceApiKey | null,
    current: WorkspaceApiKey,
  ) {
    const event: ApiKeyEvent = {
      id: randomUUID(),
      keyId: current.id,
      type,
      at: new Date(this.now()).toISOString(),
      actor: "workspace_owner_credential",
      previous,
      current,
    };
    this.store.db
      .prepare("INSERT INTO api_key_events VALUES (?,?,?)")
      .run(event.id, current.id, JSON.stringify(event));
  }
  events(id: string): ApiKeyEvent[] {
    this.get(id);
    return this.store.db
      .prepare(
        "SELECT body FROM api_key_events WHERE key_id=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(id)
      .map((r) => JSON.parse(String(r.body)));
  }
  create(raw: unknown) {
    const input = createInput.parse(raw);
    const signature = hash(JSON.stringify(input));
    return this.store.transaction(() => {
      const old = this.store.db
        .prepare(
          "SELECT id,input_hash FROM workspace_api_keys WHERE create_request_key=?",
        )
        .get(input.requestKey);
      if (old) {
        if (old.input_hash !== signature)
          throw new ApiKeyError(
            409,
            "This creation request was already used with different key settings.",
          );
        return { key: this.get(String(old.id)), secret: null, replayed: true };
      }
      const keys = this.list();
      if (
        keys.length >= 1000 ||
        keys.filter((k) => !k.revokedAt && Date.parse(k.expiresAt) > this.now())
          .length >= 100
      )
        throw new ApiKeyError(
          409,
          "Workspace API key limit reached. Revoke unused keys before creating another.",
        );
      const secret = `oct_key_${randomBytes(32).toString("base64url")}`;
      const at = new Date(this.now()).toISOString();
      const body: KeyBody = {
        id: randomUUID(),
        workspaceId: this.workspaceId,
        name: input.name,
        prefix: `${secret.slice(0, 12)}…${secret.slice(-4)}`,
        scopes: input.scopes,
        allowedTools: input.allowedTools,
        limitMicros: input.limitUsd,
        revision: 0,
        createdAt: at,
        expiresAt: new Date(
          this.now() + input.expiresInDays * 86400000,
        ).toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      };
      this.store.db
        .prepare("INSERT INTO workspace_api_keys VALUES (?,?,?,?,?,?,0,0)")
        .run(
          body.id,
          this.workspaceId,
          hash(secret),
          input.requestKey,
          signature,
          JSON.stringify(body),
        );
      const key = this.get(body.id);
      this.audit("created", null, key);
      return { key, secret, replayed: false };
    });
  }
  update(id: string, raw: unknown) {
    const input = updateInput.parse(raw);
    return this.store.transaction(() => {
      const previous = this.get(id);
      if (previous.status === "expired" || previous.status === "revoked")
        throw new ApiKeyError(
          409,
          "Expired or revoked keys cannot be edited. Create a replacement key.",
        );
      if (previous.revision !== input.revision)
        throw new ApiKeyError(
          409,
          "Key settings changed. Refresh before saving.",
        );
      if (input.limitUsd < previous.spentMicros + previous.reservedMicros)
        throw new ApiKeyError(
          409,
          "The limit cannot be lower than spent and reserved estimates.",
        );
      this.store.db
        .prepare(
          "UPDATE workspace_api_keys SET body=json_set(body,'$.name',?,'$.scopes',json(?),'$.allowedTools',json(?),'$.limitMicros',?,'$.revision',?) WHERE id=?",
        )
        .run(
          input.name,
          JSON.stringify(input.scopes),
          JSON.stringify(input.allowedTools),
          input.limitUsd,
          previous.revision + 1,
          id,
        );
      const current = this.get(id);
      this.audit("updated", previous, current);
      return current;
    });
  }
  revoke(id: string, raw: unknown) {
    const input = z
      .object({ revision: z.number().int().nonnegative() })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const previous = this.get(id);
      if (previous.revokedAt) return previous;
      if (previous.revision !== input.revision)
        throw new ApiKeyError(
          409,
          "Key settings changed. Refresh before revoking.",
        );
      this.store.db
        .prepare(
          "UPDATE workspace_api_keys SET body=json_set(body,'$.revokedAt',?,'$.revision',?) WHERE id=?",
        )
        .run(new Date(this.now()).toISOString(), previous.revision + 1, id);
      const current = this.get(id);
      this.audit("revoked", previous, current);
      return current;
    });
  }
  toolAccess(id: string, tool: (typeof API_KEY_TOOLS)[number]) {
    const key = this.active(id);
    if (
      !key.scopes.includes("tools:execute") ||
      !key.allowedTools.includes(tool)
    )
      throw new ApiKeyError(403, "This API key cannot execute this tool.");
    return key;
  }
  /** Called inside the same transaction that creates the provider call receipt. */
  reserve(
    id: string,
    callId: string,
    tool: (typeof API_KEY_TOOLS)[number],
    amount: number,
  ) {
    const key = this.toolAccess(id, tool);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error("Invalid key reservation");
    if (key.spentMicros + key.reservedMicros + amount > key.limitMicros)
      throw new ApiKeyError(
        409,
        "This call would exceed the API key's total estimated-spend limit.",
      );
    this.store.db
      .prepare("INSERT INTO api_key_spend VALUES (?,?,?,'reserved',?,NULL)")
      .run(callId, id, amount, new Date(this.now()).toISOString());
    this.store.db
      .prepare(
        "UPDATE workspace_api_keys SET reserved_micros=reserved_micros+? WHERE id=?",
      )
      .run(amount, id);
  }
  /** Called with provider settlement/recovery in the enclosing receipt transaction. */
  settle(callId: string) {
    const row = this.store.db
      .prepare(
        "SELECT key_id,amount_micros FROM api_key_spend WHERE call_id=? AND state='reserved'",
      )
      .get(callId);
    if (!row) return;
    this.store.db
      .prepare(
        "UPDATE workspace_api_keys SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+? WHERE id=?",
      )
      .run(row.amount_micros, row.amount_micros, row.key_id);
    this.store.db
      .prepare(
        "UPDATE api_key_spend SET state='settled',settled_at=? WHERE call_id=?",
      )
      .run(new Date(this.now()).toISOString(), callId);
  }
}

/** Explicit allowlist: scoped credentials cannot access owner/admin/legacy billing paths. */
export function requiredApiKeyScope(
  method: string,
  path: string,
): ApiKeyScope | null {
  if (method === "GET" && path === "/api/observations/catalog")
    return "tools:discover";
  if (method === "POST" && path === "/api/workspace/preview")
    return "tools:discover";
  if (method === "GET" && path === "/api/workspace/usage") return "usage:read";
  if (method === "GET" && path === "/api/workspace/activity")
    return "research:read";
  if (
    ["GET", "POST"].includes(method) &&
    path === "/api/observations/connection"
  )
    return method === "GET" ? "research:read" : "research:write";
  if (method === "POST" && path === "/api/observations/agent-sessions")
    return "research:write";
  const session = "[0-9a-fA-F-]{36}";
  if (
    method === "GET" &&
    (path === "/api/observations" ||
      new RegExp(
        `^/api/observations/${session}(?:/calls/${session}|/export)?$`,
      ).test(path))
  )
    return "research:read";
  if (
    method === "POST" &&
    new RegExp(`^/api/observations/${session}/discover$`).test(path)
  )
    return "tools:discover";
  if (
    method === "POST" &&
    new RegExp(`^/api/observations/${session}/call$`).test(path)
  )
    return "tools:execute";
  if (
    method === "POST" &&
    new RegExp(`^/api/observations/${session}/outcome$`).test(path)
  )
    return "research:write";
  return null;
}
