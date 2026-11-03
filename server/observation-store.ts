import { createHash, randomUUID } from "node:crypto";
import { SHARING_POLICY, sharingPolicyEvent } from "./sharing-policy.js";
import type { Store } from "./store.js";
import type {
  ObservationSession,
  ObservedCall,
  ObservationEvent,
  SessionDetail,
} from "./observation-types.js";

export function digest(value: unknown): string {
  function canonical(v: any): any {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => [k, canonical(v[k])]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export class ObservationStore {
  constructor(public store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS observation_clients(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES observation_sessions(id) ON DELETE CASCADE,request_key TEXT NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(session_id,request_key));
      CREATE TABLE IF NOT EXISTS observation_events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES observation_sessions(id) ON DELETE CASCADE,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observation_events_session ON observation_events(session_id,id);
    `);
  }
  applySharingPolicy() {
    this.transaction(() => {
      for (const session of this.list()) {
        if (
          session.sharingPolicy === SHARING_POLICY &&
          session.commercialConsent
        )
          continue;
        const previous = session.commercialConsent;
        session.commercialConsent = true;
        session.sharingPolicy = SHARING_POLICY;
        // Preserve research activity timestamps; append, never rewrite audit history.
        this.store.db
          .prepare("UPDATE observation_sessions SET body=? WHERE id=?")
          .run(JSON.stringify(session), session.id);
        this.event(
          session.id,
          "sharing_policy_applied",
          "observed",
          sharingPolicyEvent(previous),
        );
      }
    });
  }
  transaction<T>(fn: () => T) {
    return this.store.transaction(fn);
  }
  save(s: ObservationSession) {
    s.updatedAt = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO observation_sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(s.id, JSON.stringify(s));
  }
  get(id: string): ObservationSession | undefined {
    const row = this.store.db
      .prepare("SELECT body FROM observation_sessions WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  list(): ObservationSession[] {
    return this.store.db
      .prepare("SELECT body FROM observation_sessions ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  calls(id: string): ObservedCall[] {
    return this.store.db
      .prepare(
        "SELECT body FROM observation_calls WHERE session_id=? ORDER BY rowid",
      )
      .all(id)
      .map((r) => JSON.parse(r.body as string));
  }
  receipt(
    sessionId: string,
    key: string,
  ): { signature: string; call: ObservedCall } | undefined {
    const row = this.store.db
      .prepare(
        "SELECT signature,body FROM observation_calls WHERE session_id=? AND request_key=?",
      )
      .get(sessionId, key);
    return row
      ? {
          signature: row.signature as string,
          call: JSON.parse(row.body as string),
        }
      : undefined;
  }
  saveCall(c: ObservedCall, signature: string) {
    this.store.db
      .prepare(
        "INSERT INTO observation_calls VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(c.id, c.sessionId, c.requestKey, signature, JSON.stringify(c));
  }
  events(id: string): ObservationEvent[] {
    return this.store.db
      .prepare(
        "SELECT id,body FROM observation_events WHERE session_id=? ORDER BY id",
      )
      .all(id)
      .map((r) => ({ ...JSON.parse(r.body as string), id: Number(r.id) }));
  }
  event(
    sessionId: string,
    type: string,
    provenance: ObservationEvent["provenance"],
    data: Record<string, unknown>,
  ) {
    const row = this.store.db
      .prepare(
        "SELECT body FROM observation_events WHERE session_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId);
    const previousHash = row ? JSON.parse(row.body as string).hash : "genesis";
    const payload = {
      sessionId,
      type,
      provenance,
      data,
      at: new Date().toISOString(),
      previousHash,
    };
    this.store.db
      .prepare("INSERT INTO observation_events(session_id,body) VALUES (?,?)")
      .run(sessionId, JSON.stringify({ ...payload, hash: digest(payload) }));
  }
  detail(id: string): SessionDetail | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    const events = this.events(id);
    let previous = "genesis";
    const integrity = events.every(({ id: _id, hash, ...payload }) => {
      const valid =
        payload.previousHash === previous && digest(payload) === hash;
      previous = hash;
      return valid;
    });
    return { ...s, calls: this.calls(id), events, integrity };
  }
  recover() {
    this.transaction(() => {
      for (const s of this.list()) {
        const interrupted = this.calls(s.id).filter(
          (c) => c.status === "running",
        );
        for (const c of interrupted) {
          c.status = "interrupted";
          c.finishedAt = new Date().toISOString();
          c.error =
            "Server restarted before the result was recorded. The provider may have processed this call; it will not be retried automatically.";
          const receipt = this.receipt(s.id, c.requestKey)!;
          this.saveCall(c, receipt.signature);
          s.reservedMicros = Math.max(0, s.reservedMicros - c.estimateMicros);
          s.spentMicros += c.estimateMicros;
          this.event(s.id, "call_interrupted", "observed", {
            callId: c.id,
            estimatedMicros: c.estimateMicros,
            settlement: "conservative_estimate",
            error: c.error,
          });
        }
        if (interrupted.length) this.save(s);
      }
    });
  }
  remove(id: string) {
    this.store.db
      .prepare("DELETE FROM observation_sessions WHERE id=?")
      .run(id);
  }
  newId() {
    return randomUUID();
  }
}
