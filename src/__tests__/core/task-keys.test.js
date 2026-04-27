import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { formatTaskKey, nextTaskKey, normalizeTaskKey } from "../../core/task-keys.js";

describe("task keys", () => {
  it("formats and normalizes public keys", () => {
    expect(formatTaskKey(12)).toBe("T-12");
    expect(normalizeTaskKey("t-0012")).toBe("T-12");
    expect(normalizeTaskKey("nope")).toBeNull();
  });

  it("allocates the next unused task key", () => {
    const db = makeTestDb();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, task_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("a", "T-1", "a", now, now);
    db.prepare("INSERT INTO tasks (id, task_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("b", "T-3", "b", now, now);

    expect(nextTaskKey(db)).toBe("T-4");
    expect(db.prepare("SELECT value FROM settings WHERE key = 'task_key_next'").get().value).toBe("5");
  });
});
