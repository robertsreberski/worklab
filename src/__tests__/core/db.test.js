import { describe, it, expect } from "vitest";
import { openDb, runMigrations } from "../../core/db.js";
import { newTaskId } from "../../core/ids.js";

describe("openDb + runMigrations", () => {
  it("creates all tables on first call", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "agents", "tasks", "task_comments", "task_runs", "agent_logs",
        "custom_providers", "custom_models", "embeddings", "settings",
        "agent_consolidations", "task_dependencies", "automations", "automation_runs",
        "automation_triggers", "task_edges",
      ]),
    );
  });

  it("idempotent: safe to run twice", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(newTaskId(), "ok", now, now);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c).toBe(1);
  });

  it("enforces foreign keys", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() =>
      db
        .prepare("INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("c1", "does-not-exist", "human", "hi", Date.now()),
    ).toThrow();
  });

  it("records schema version", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const row = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
    expect(row.value).toBe("11");
  });

  it("migration drops legacy task workflow columns and schedule tables", () => {
    const db = openDb(":memory:");
    // Seed a v4-shape tasks + schedules table with priority + description.
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        executor_agent TEXT,
        reviewer_agent TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        error_text TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        source_schedule_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        executor_agent TEXT,
        reviewer_agent TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        cadence_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at INTEGER,
        last_fired_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    db.prepare(
      "INSERT INTO tasks (id, title, description, instructions, status, executor_agent, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("t1", "keep me", "drop me", "stay", "todo", "legacy-owner", 2, now, now);
    db.prepare(
      "INSERT INTO schedules (id, title, description, instructions, executor_agent, priority, cadence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("s1", "sched", "drop sched desc", "stay", "legacy-owner", 1, "{}", now, now);
    runMigrations(db);
    const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map((r) => r.name);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(taskCols).not.toContain("priority");
    expect(taskCols).not.toContain("description");
    expect(taskCols).not.toContain("status");
    expect(taskCols).not.toContain("executor_agent");
    expect(taskCols).not.toContain("source_schedule_id");
    expect(tables).not.toContain("schedules");
    expect(tables).not.toContain("schedule_spawns");
    const taskRow = db.prepare("SELECT id, title, instructions, stage, owner_agent, root_task_id, run_policy FROM tasks WHERE id='t1'").get();
    expect(taskRow).toMatchObject({
      id: "t1",
      title: "keep me",
      instructions: "stay",
      stage: "execute",
      owner_agent: "legacy-owner",
      root_task_id: "t1",
      run_policy: "manual",
    });
    expect(taskCols).toEqual(expect.arrayContaining(["stage", "owner_agent", "parent_task_id", "pending_actions_json", "client_request_id", "plan_body", "run_policy"]));
  });

  it("allows taskless consolidation runs", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at) VALUES (?, NULL, ?, ?, ?)")
      .run("r1", "consolidate", "alice", Date.now());
    const row = db.prepare("SELECT task_id, mode FROM task_runs WHERE id = 'r1'").get();
    expect(row).toMatchObject({ task_id: null, mode: "consolidate" });
  });

  it("migrates legacy taskless automations before creating task indexes", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.exec(`
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        agent_name TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        trigger_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at INTEGER,
        last_fired_at INTEGER,
        last_run_id TEXT,
        last_status TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO automations (
        id, title, instructions, agent_name, tags, trigger_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("auto_legacy", "Legacy", "Keep this", "agent", "[]", "{\"type\":\"daily\"}", now, now);

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(automations)").all().map((r) => r.name);
    const row = db.prepare("SELECT id, task_id, title, instructions FROM automations WHERE id = 'auto_legacy'").get();
    expect(columns).toContain("task_id");
    expect(row).toMatchObject({ id: "auto_legacy", task_id: null, title: "Legacy", instructions: "Keep this" });
  });

  it("does not rewrite legacy tier model strings during migration", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy", "Legacy", "claude", "sonnet", now, now);
    runMigrations(db);
    const row = db.prepare("SELECT sdk, model FROM agents WHERE name = 'legacy'").get();
    expect(row).toMatchObject({ sdk: "claude", model: "sonnet" });
  });
});
