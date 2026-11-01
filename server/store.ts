import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Task, TraceEvent, Observation } from "./types.js";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db
        .exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, call_id TEXT, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS event_ledger_once ON events(call_id,type) WHERE call_id IS NOT NULL AND type IN ('budget_reserved','budget_settled','provider_request','provider_response');`);
    } catch (error) {
      this.db.close();
      if (error instanceof Error && /locked|busy/i.test(error.message))
        throw new Error(
          "Workspace database is already in use. Stop the other server or maintenance process before retrying.",
        );
      throw error;
    }
  }
  save(task: Task) {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(task.id, JSON.stringify(task));
  }
  get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT body FROM tasks ORDER BY rowid DESC LIMIT 500")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  event(
    taskId: string,
    type: string,
    data: Record<string, any>,
    callId: string | null = null,
  ) {
    this.db
      .prepare(
        "INSERT INTO events(task_id,call_id,type,at,data) VALUES (?,?,?,?,?)",
      )
      .run(
        taskId,
        callId,
        type,
        new Date().toISOString(),
        JSON.stringify(data),
      );
  }
  events(taskId: string): TraceEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE task_id=? ORDER BY id")
      .all(taskId)
      .map((r) => ({
        id: Number(r.id),
        taskId: r.task_id as string,
        callId: r.call_id as string | null,
        type: r.type as string,
        at: r.at as string,
        data: JSON.parse(r.data as string),
      }));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  observations(): Observation[] {
    const tasks = new Map<string, Task>();
    return this.db
      .prepare(
        "SELECT task_id,call_id,data FROM events WHERE type='provider_response' ORDER BY id DESC LIMIT 200",
      )
      .all()
      .map((r) => {
        const observation = JSON.parse(r.data as string);
        const id = r.task_id as string;
        let task = tasks.get(id);
        if (!task) {
          task = this.get(id)!;
          tasks.set(id, task);
        }
        const sourceIds = new Set(
          task.sources.filter((s) => s.callId === r.call_id).map((s) => s.id),
        );
        const audited = task.assessments.filter(
          (a) =>
            sourceIds.has(a.sourceId) &&
            a.note &&
            task!.intent.criteria.every(
              (c) => a.criteria[c] === "pass" || a.criteria[c] === "fail",
            ),
        );
        const quality = audited.length
          ? audited.reduce(
              (sum, a) =>
                sum +
                task!.intent.criteria.filter((c) => a.criteria[c] === "pass")
                  .length /
                  task!.intent.criteria.length,
              0,
            ) / audited.length
          : null;
        return {
          provider: observation.provider,
          latencyMs: observation.latencyMs,
          success: observation.success,
          quality,
        };
      });
  }
  recover() {
    for (const task of this.tasks())
      if (task.status === "running" || task.reservedMicros > 0)
        this.transaction(() => {
          // A process crash cannot establish whether an in-flight vendor request was billed.
          task.spentMicros += task.reservedMicros;
          task.reservedMicros = 0;
          task.status = "partial";
          task.error =
            "Run interrupted by server restart. In-flight estimates remain in the ledger; billing is unknown.";
          const events = this.events(task.id);
          for (const pending of events.filter(
            (e) =>
              e.type === "budget_reserved" &&
              !events.some(
                (s) => s.type === "budget_settled" && s.callId === e.callId,
              ),
          )) {
            this.event(
              task.id,
              "provider_interrupted",
              {
                provider: pending.data.provider,
                billingStatus: "unknown",
                reason: "Server restarted with request in flight",
              },
              pending.callId,
            );
            this.event(
              task.id,
              "budget_settled",
              {
                provider: pending.data.provider,
                estimateMicros: pending.data.estimateMicros,
                chargeType: pending.data.chargeType || "estimate",
                authMode: pending.data.authMode,
                billingStatus:
                  pending.data.authMode === "keyless"
                    ? "keyless-free-tier"
                    : "unknown",
                rateCardVersion: pending.data.rateCardVersion,
              },
              pending.callId,
            );
          }
          this.save(task);
          this.event(task.id, "run_interrupted", {
            reason: task.error,
            billing: "unknown",
          });
        });
  }
  close() {
    this.db.close();
  }
}
