import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AccountError,
  type Accounts,
  type VerifiedIdentity,
} from "./accounts.js";
import { config } from "./config.js";
import type {
  ToolCompany,
  CompanyInsights,
  CompanyReviewItem,
} from "./company-types.js";
const fields = `id,name,website,tool_name AS "toolName",description,status,provider_id AS "providerId",insights_enabled AS "insightsEnabled",feedback,revision,created_at AS "createdAt",updated_at AS "updatedAt"`;
const registration = z
  .object({
    name: z.string().trim().min(2).max(80),
    website: z
      .url()
      .max(300)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Use a public HTTPS company website."),
    toolName: z.string().trim().min(2).max(80),
    description: z.string().trim().min(20).max(1500),
    requestKey: z.uuid(),
  })
  .strict();
export class Companies {
  constructor(private accounts: Accounts) {}
  private get pool() {
    return this.accounts.database.pool;
  }
  async list(identity: VerifiedIdentity): Promise<ToolCompany[]> {
    return (
      await this.pool.query(
        `SELECT ${fields} FROM octolab.tool_companies WHERE owner_user_id=$1 ORDER BY created_at,id`,
        [identity.userId],
      )
    ).rows;
  }
  async get(identity: VerifiedIdentity, id: string): Promise<ToolCompany> {
    if (!z.uuid().safeParse(id).success)
      throw new AccountError(404, "Company not found.");
    const rows = await this.pool.query(
      `SELECT ${fields} FROM octolab.tool_companies WHERE id=$1 AND (owner_user_id=$2 OR $3)`,
      [id, identity.userId, this.accounts.isAdmin(identity.userId)],
    );
    if (!rows.rowCount) throw new AccountError(404, "Company not found.");
    return rows.rows[0];
  }
  async register(
    identity: VerifiedIdentity,
    raw: unknown,
  ): Promise<ToolCompany> {
    const input = registration.parse(raw),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["company:" + identity.userId],
      );
      const old = await client.query(
        `SELECT ${fields} FROM octolab.tool_companies WHERE owner_user_id=$1 AND request_key=$2`,
        [identity.userId, input.requestKey],
      );
      if (old.rowCount) {
        const row = old.rows[0];
        if (
          row.name !== input.name ||
          row.website !== input.website ||
          row.toolName !== input.toolName ||
          row.description !== input.description
        )
          throw new AccountError(
            409,
            "This registration request was already used.",
          );
        await client.query("COMMIT");
        return row;
      }
      const count = await client.query(
        "SELECT count(*)::integer AS n FROM octolab.tool_companies WHERE owner_user_id=$1",
        [identity.userId],
      );
      if (count.rows[0].n >= 5)
        throw new AccountError(409, "Company registration limit reached.");
      const result = await client.query(
        `INSERT INTO octolab.tool_companies(id,owner_user_id,request_key,name,website,tool_name,description) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${fields}`,
        [
          randomUUID(),
          identity.userId,
          input.requestKey,
          input.name,
          input.website,
          input.toolName,
          input.description,
        ],
      );
      await client.query(
        "INSERT INTO octolab.company_review_events(id,company_id,actor_user_id,revision,data) VALUES($1,$2,$3,0,$4)",
        [
          randomUUID(),
          result.rows[0].id,
          identity.userId,
          JSON.stringify({ action: "registered" }),
        ],
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async resubmit(
    identity: VerifiedIdentity,
    id: string,
    raw: unknown,
  ): Promise<ToolCompany> {
    const input = registration
      .omit({ requestKey: true })
      .extend({ revision: z.number().int().nonnegative() })
      .parse(raw);
    await this.get(identity, id);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE octolab.tool_companies SET name=$1,website=$2,tool_name=$3,description=$4,status='pending',provider_id=NULL,insights_enabled=false,revision=revision+1,updated_at=now() WHERE id=$5 AND owner_user_id=$6 AND revision=$7 AND status IN ('pending','rejected') RETURNING ${fields}`,
        [
          input.name,
          input.website,
          input.toolName,
          input.description,
          id,
          identity.userId,
          input.revision,
        ],
      );
      if (!result.rowCount)
        throw new AccountError(
          409,
          "This registration changed or cannot be resubmitted. Refresh to see its current status.",
        );
      await client.query(
        "INSERT INTO octolab.company_review_events(id,company_id,actor_user_id,revision,data) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          id,
          identity.userId,
          result.rows[0].revision,
          JSON.stringify({ action: "resubmitted", ...input }),
        ],
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private admin(identity: VerifiedIdentity) {
    if (!this.accounts.isAdmin(identity.userId))
      throw new AccountError(403, "Platform administrator access is required.");
  }
  async queue(
    identity: VerifiedIdentity,
    raw: unknown = {},
  ): Promise<{ items: CompanyReviewItem[]; nextCursor: string | null }> {
    this.admin(identity);
    const input = z
      .object({
        status: z
          .enum(["all", "pending", "approved", "rejected", "suspended"])
          .default("pending"),
        cursor: z.string().max(1000).optional(),
      })
      .strict()
      .parse(raw);
    let cursor: { at: string; id: string } | undefined;
    if (input.cursor) {
      try {
        cursor = z
          .object({ at: z.iso.datetime({ offset: true }), id: z.uuid() })
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
      } catch {
        throw new AccountError(400, "Invalid company review cursor.");
      }
    }
    const result = await this.pool.query(
      `SELECT c.id,c.name,c.website,c.tool_name AS "toolName",c.description,c.status,c.provider_id AS "providerId",c.insights_enabled AS "insightsEnabled",c.feedback,c.revision,c.created_at AS "createdAt",c.updated_at AS "updatedAt",u.email AS "ownerEmail",to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt" FROM octolab.tool_companies c JOIN auth.users u ON u.id=c.owner_user_id WHERE ($1='all' OR c.status=$1) AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2::timestamptz,$3::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT 101`,
      [input.status, cursor?.at ?? null, cursor?.id ?? null],
    );
    const items = result.rows.slice(0, 100),
      last = items.at(-1);
    return {
      items: items.map(({ cursorAt, ...item }) => item),
      nextCursor:
        result.rows.length > 100
          ? Buffer.from(
              JSON.stringify({
                at: last.cursorAt,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }
  async review(identity: VerifiedIdentity, id: string, raw: unknown) {
    this.admin(identity);
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        status: z.enum(["approved", "rejected", "suspended"]),
        providerId: z.enum(["exa", "tavily", "firecrawl"]).nullable(),
        insightsEnabled: z.boolean(),
        feedback: z.string().trim().min(5).max(1500),
      })
      .strict()
      .parse(raw);
    if (input.status === "approved" && !input.providerId)
      throw new AccountError(
        400,
        "Choose the integrated provider this company owns.",
      );
    if (input.insightsEnabled && input.status !== "approved")
      throw new AccountError(
        400,
        "Only approved companies can receive aggregate insights.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.get(identity, id);
      const result = await client.query(
        `UPDATE octolab.tool_companies SET status=$1,provider_id=$2,insights_enabled=$3,feedback=$4,revision=revision+1,updated_at=now() WHERE id=$5 AND revision=$6 RETURNING ${fields}`,
        [
          input.status,
          input.providerId,
          input.insightsEnabled,
          input.feedback,
          id,
          input.revision,
        ],
      );
      if (!result.rowCount)
        throw new AccountError(
          409,
          "This company was reviewed elsewhere. Refresh before reviewing again.",
        );
      await client.query(
        "INSERT INTO octolab.company_review_events(id,company_id,actor_user_id,revision,data) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          id,
          identity.userId,
          result.rows[0].revision,
          JSON.stringify(input),
        ],
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new AccountError(
          409,
          "That provider already belongs to another approved company.",
        );
      throw error;
    } finally {
      client.release();
    }
  }
  async history(identity: VerifiedIdentity, id: string) {
    this.admin(identity);
    await this.get(identity, id);
    return (
      await this.pool.query(
        'SELECT actor_user_id AS "actorId",at,revision,data FROM octolab.company_review_events WHERE company_id=$1 ORDER BY revision DESC',
        [id],
      )
    ).rows;
  }
  async insights(
    identity: VerifiedIdentity,
    id: string,
  ): Promise<CompanyInsights> {
    const company = await this.get(identity, id);
    if (company.status !== "approved" || !company.providerId)
      throw new AccountError(
        403,
        "Company approval is required before insights are available.",
      );
    const base = {
      providerId: company.providerId,
      minimumCohort: config.minCohort,
    };
    if (!company.insightsEnabled)
      return { ...base, status: "awaiting_release", metrics: null };
    // Only aggregate counts leave the backend. No queries, outputs, IDs, or consumer-level slices.
    // Require independent workspaces as well as sessions; repeated calls by one tenant cannot unlock sharing.
    const result = await this.pool.query(
      `WITH eligible AS (
      SELECT s.workspace_id,s.id,(
        SELECT min(e.body::jsonb->>'at') FROM octolab.observation_events e
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.body::jsonb->'data'->'tools')='array' THEN e.body::jsonb->'data'->'tools' ELSE '[]'::jsonb END) t
        WHERE e.workspace_id=s.workspace_id AND e.session_id=s.id AND e.body::jsonb->>'type'='tools_offered' AND t->>'provider'=$1 AND t->>'available'='true'
        AND (NOT (t ? 'discoveryMatches') OR jsonb_array_length(t->'discoveryMatches')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'discoveryMatches') m WHERE m->>'status'='eligible'))
      ) AS offered_at FROM octolab.observation_sessions s WHERE (s.body::jsonb->>'commercialConsent')='true'
      AND EXISTS (SELECT 1 FROM octolab.observation_events e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.body::jsonb->'data'->'tools')='array' THEN e.body::jsonb->'data'->'tools' ELSE '[]'::jsonb END) t
        WHERE e.workspace_id=s.workspace_id AND e.session_id=s.id AND e.body::jsonb->>'type'='tools_offered' AND t->>'provider'=$1 AND t->>'available'='true' AND (NOT (t ? 'discoveryMatches') OR jsonb_array_length(t->'discoveryMatches')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'discoveryMatches') m WHERE m->>'status'='eligible')))
    ), calls AS (
      SELECT c.workspace_id,c.session_id,c.body::jsonb AS body FROM octolab.observation_calls c JOIN eligible e ON e.workspace_id=c.workspace_id AND e.id=c.session_id
      WHERE c.body::jsonb->>'startedAt'>=e.offered_at AND c.body::jsonb->>'provider'=$1 AND c.body::jsonb->>'status' IN ('succeeded','failed')
    ) SELECT (SELECT count(DISTINCT workspace_id) FROM eligible)::integer AS tenants,
      (SELECT count(*) FROM eligible)::integer AS offered,
      (SELECT count(*) FROM (SELECT DISTINCT workspace_id,session_id FROM calls) x)::integer AS selected,
      (SELECT count(*) FROM (SELECT DISTINCT workspace_id FROM calls) x)::integer AS selected_tenants,
      count(*)::integer AS calls,count(*) FILTER (WHERE body->>'status'='succeeded')::integer AS succeeded FROM calls`,
      [company.providerId],
    );
    const row = result.rows[0];
    if (
      row.tenants < config.minCohort ||
      row.selected_tenants < config.minCohort ||
      row.selected < config.minCohort
    )
      return { ...base, status: "insufficient_data", metrics: null };
    return {
      ...base,
      status: "available",
      metrics: {
        offeredSessions: row.offered,
        selectedSessions: row.selected,
        calls: row.calls,
        successfulCalls: row.succeeded,
      },
    };
  }
}
