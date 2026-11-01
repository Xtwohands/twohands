import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store";
import { createTask } from "./helpers";
describe("single-process workspace ownership", () => {
  it("blocks a second database owner instead of recovering another live server’s tasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "apilayer-lock-"));
    const path = join(dir, "workspace.sqlite");
    const first = new Store(path);
    try {
      const task = createTask(first);
      expect(() => new Store(path)).toThrow("already in use");
      expect(first.get(task.id)?.status).toBe("running");
    } finally {
      first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("releases ownership on close and preserves state for restart recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "apilayer-reopen-"));
    const path = join(dir, "workspace.sqlite");
    try {
      const first = new Store(path);
      const task = createTask(first);
      first.close();
      const second = new Store(path);
      second.recover();
      expect(second.get(task.id)?.status).toBe("partial");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
