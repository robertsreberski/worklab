import { describe, it, expect } from "vitest";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { newTaskId } from "../../core/ids.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../../core/db/schema/current.js";

function schemaSnapshot(db) {
  const objects = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  const columns = {};
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  for (const { name } of tables) {
    columns[name] = db.prepare(`PRAGMA table_info(${name})`).all().map((row) => ({
      name: row.name,
      type: row.type,
      notnull: row.notnull,
      dflt_value: row.dflt_value,
      pk: row.pk,
    }));
  }
  return { objects, columns };
}

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
        "projects",
        "custom_providers", "custom_models", "embeddings", "settings",
        "agent_consolidations", "task_dependencies", "automations", "automation_runs",
        "automation_triggers", "task_edges", "slack_inbound_events", "slack_triage_runs",
        "slack_agent_logs", "slack_delivery_log", "assistant_threads", "assistant_messages",
        "assistant_runs", "assistant_agent_logs", "run_compactions", "task_attachments",
        "acp_profiles", "acp_operations", "acp_interactions",
      ]),
    );
  });

  it("creates the v50 ACP tables, constraints, and active-owner indexes", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (name, display_name, sdk, model, execution_mode, created_at, updated_at)
      VALUES ('external', 'External', 'acp', 'acp:00000000-0000-4000-8000-000000000001', 'acp', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO acp_profiles (
        id, agent_name, driver, command, args_json, env_keys_json,
        configuration_owner, workspace_owner, mcp_owner, created_at, updated_at
      ) VALUES (?, 'external', 'generic', ?, '[]', '["ACP_TOKEN"]', 'client', 'client', 'client', ?, ?)
    `).run("00000000-0000-4000-8000-000000000001", process.execPath, now, now);
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json, created_at, updated_at
      ) VALUES (?, ?, 'authenticate', 'running', '{}', '{}', '{}', ?, ?)
    `).run(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
      now,
      now,
    );

    const insertInteraction = db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, task_run_id, operation_id, protocol_request_id,
        kind, request_schema_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'form', '{}', 'pending', ?, ?)
    `);
    expect(() => insertInteraction.run(
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
      null,
      null,
      "missing-owner",
      now,
      now,
    )).toThrow();

    insertInteraction.run(
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000001",
      null,
      "00000000-0000-4000-8000-000000000002",
      "request-1",
      now,
      now,
    );
    expect(() => insertInteraction.run(
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000001",
      null,
      "00000000-0000-4000-8000-000000000002",
      "request-1",
      now,
      now,
    )).toThrow();
    db.prepare("UPDATE acp_interactions SET state = 'submitted' WHERE id = ?")
      .run("00000000-0000-4000-8000-000000000004");
    expect(() => insertInteraction.run(
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000001",
      null,
      "00000000-0000-4000-8000-000000000002",
      "request-1",
      now,
      now,
    )).not.toThrow();

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_acp_%'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      "idx_acp_interactions_pending_operation_request",
      "idx_acp_interactions_pending_run_request",
      "idx_acp_interactions_pending_profile",
      "idx_acp_operations_active",
      "idx_acp_operations_one_active_profile",
      "idx_acp_profiles_mono_source",
    ]));
  });

  it("reconciles legacy active ACP operations before adding the unique profile guard", () => {
    const db = openDb(":memory:");
    db.exec(SCHEMA_SQL);
    db.exec("DROP INDEX idx_acp_operations_one_active_profile");
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (name, display_name, sdk, model, execution_mode, created_at, updated_at)
      VALUES ('legacy-acp', 'Legacy ACP', 'acp', 'acp:00000000-0000-4000-8000-000000000011', 'acp', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO acp_profiles (
        id, agent_name, driver, command, args_json, env_keys_json,
        configuration_owner, workspace_owner, mcp_owner, created_at, updated_at
      ) VALUES (?, 'legacy-acp', 'generic', ?, '[]', '[]', 'client', 'client', 'client', ?, ?)
    `).run("00000000-0000-4000-8000-000000000011", process.execPath, now, now);
    const insertOperation = db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json, created_at, updated_at
      ) VALUES (?, ?, 'probe', ?, '{}', '{}', '{}', ?, ?)
    `);
    insertOperation.run(
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000011",
      "running",
      now - 2,
      now - 2,
    );
    insertOperation.run(
      "00000000-0000-4000-8000-000000000013",
      "00000000-0000-4000-8000-000000000011",
      "waiting_for_interaction",
      now - 1,
      now - 1,
    );
    db.prepare(`
      INSERT INTO schema_meta (key, value) VALUES ('version', '49')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();

    runMigrations(db);

    const rows = db.prepare(`
      SELECT state, error_json, completed_at
      FROM acp_operations ORDER BY id
    `).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.state).toBe("failed");
      expect(row.completed_at).toEqual(expect.any(Number));
      expect(JSON.parse(row.error_json)).toEqual({
        code: "coordinator_restarted",
        message: "Worklab restarted before the ACP operation completed.",
      });
    }
    expect(db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_acp_operations_one_active_profile'
    `).get()?.sql).toContain("CREATE UNIQUE INDEX");
    insertOperation.run(
      "00000000-0000-4000-8000-000000000014",
      "00000000-0000-4000-8000-000000000011",
      "queued",
      now + 1,
      now + 1,
    );
    expect(() => insertOperation.run(
      "00000000-0000-4000-8000-000000000015",
      "00000000-0000-4000-8000-000000000011",
      "running",
      now + 2,
      now + 2,
    )).toThrowError(/acp_operations\.profile_id/u);
    expect(() => insertOperation.run(
      "00000000-0000-4000-8000-000000000016",
      "00000000-0000-4000-8000-000000000011",
      "succeeded",
      now + 3,
      now + 3,
    )).not.toThrow();
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value)
      .toBe(String(SCHEMA_VERSION));
  });

  it("idempotent: safe to run twice", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    runMigrations(db);
    const now = Date.now();
    const taskId = newTaskId();
    db.prepare(
      "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(taskId, "ok", now, now);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c).toBe(1);
    expect(db.prepare("SELECT run_policy FROM tasks WHERE id = ?").get(taskId).run_policy).toBe("auto_plan_execute");
  });

  it("keeps the declared current schema in sync with fresh migrations", () => {
    const current = openDb(":memory:");
    current.exec(SCHEMA_SQL);
    const migrated = openDb(":memory:");
    runMigrations(migrated);

    expect(schemaSnapshot(migrated)).toEqual(schemaSnapshot(current));
  });

  it("adds current index columns before replaying current schema on partial upgrades", () => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress',
        contract_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(team_id, project_id)
      );
      CREATE TABLE lead_cycles (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        run_id TEXT UNIQUE,
        team_id TEXT,
        project_id TEXT,
        reason TEXT NOT NULL DEFAULT 'manual',
        process_status TEXT NOT NULL DEFAULT 'queued',
        status TEXT NOT NULL DEFAULT 'running',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    runMigrations(db);

    expect(db.prepare("PRAGMA table_info(teams)").all().map((row) => row.name)).toContain("status");
    expect(db.prepare("PRAGMA table_info(goals)").all().map((row) => row.name)).toContain("root_task_id");
    expect(db.prepare("PRAGMA table_info(lead_cycles)").all().map((row) => row.name)).toEqual(expect.arrayContaining([
      "next_review_due_at",
      "next_review_event",
      "next_review_consumed_at",
    ]));
  });

  it("rebuilds legacy task tables even when optional workflow columns are absent", () => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        executor_agent TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        error_text TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks
        (id, title, instructions, status, executor_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-no-reviewer", "Legacy task", "Keep instructions", "todo", "old-owner", now, now);

    runMigrations(db);

    const row = db.prepare(`
      SELECT title, instructions, stage, owner_agent, reviewer_agent, run_policy, failure_count
      FROM tasks
      WHERE id = 'legacy-no-reviewer'
    `).get();
    expect(row).toMatchObject({
      title: "Legacy task",
      instructions: "Keep instructions",
      stage: "execute",
      owner_agent: "old-owner",
      reviewer_agent: null,
      run_policy: "manual",
      failure_count: 0,
    });
  });

  it("creates the run todo state column with an empty checklist default", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const columns = db.prepare("PRAGMA table_info(task_runs)").all().map((row) => row.name);
    expect(columns).toContain("todo_state_json");

    const now = Date.now();
    const taskId = newTaskId();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(taskId, "todo state", now, now);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at) VALUES (?, ?, ?, ?, ?)")
      .run("run-with-empty-todos", taskId, "execute", "agent", now);
    expect(JSON.parse(db.prepare("SELECT todo_state_json FROM task_runs WHERE id = ?").get("run-with-empty-todos").todo_state_json))
      .toEqual({ todos: [], updated_at: null, update_count: 0 });
  });

  it("creates covering summary indexes for agent list run stats", () => {
    const db = openDb(":memory:");
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(indexes).toEqual(expect.arrayContaining([
      "idx_embeddings_vector_present",
      "idx_logs_run_summary",
      "idx_runs_agent_started",
      "idx_runs_started_cost_summary",
      "idx_runs_task_status_started",
      "idx_slack_delivery_created",
      "idx_slack_triage_started",
      "idx_task_attachments_comment",
      "idx_task_attachments_task_owner",
      "idx_tasks_visible_updated",
    ]));
  });

  it("upgrades v36 embeddings before creating the vector-present index", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.exec(`
      CREATE TABLE embeddings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        agent TEXT,
        title TEXT,
        chunk_text TEXT NOT NULL,
        vector BLOB,
        model TEXT,
        content_hash TEXT NOT NULL,
        indexing_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(kind, source_ref)
      );
    `);
    db.prepare(`
      INSERT INTO embeddings
        (id, kind, ref, source_ref, chunk_text, vector, content_hash, created_at, updated_at)
      VALUES (?, 'kb', ?, ?, 'plain text', ?, 'hash', ?, ?)
    `).run("plain", "plain", "plain", null, now, now);
    db.prepare(`
      INSERT INTO embeddings
        (id, kind, ref, source_ref, chunk_text, vector, content_hash, created_at, updated_at)
      VALUES (?, 'kb', ?, ?, 'vector text', ?, 'hash2', ?, ?)
    `).run("vector", "vector", "vector", Buffer.from([1, 2, 3, 4]), now, now);

    expect(() => runMigrations(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(embeddings)").all().map((row) => row.name);
    const vectorFlags = db.prepare("SELECT id, vector_present FROM embeddings ORDER BY id").all();
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_embeddings_vector_present'").get();
    expect(columns).toContain("vector_present");
    expect(vectorFlags).toEqual([
      { id: "plain", vector_present: 0 },
      { id: "vector", vector_present: 1 },
    ]);
    expect(index?.name).toBe("idx_embeddings_vector_present");
  });

  it("clears stale task failure kind when the latest run succeeded", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    const taskId = newTaskId();
    db.prepare(
      "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare(
      `INSERT INTO tasks
        (id, root_task_id, title, stage, failure_count, last_failure_kind, error_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskId, taskId, "retry recovered", "awaiting_children", 0, "provider_unavailable", null, now, now);
    db.prepare(
      `INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, status, process_status, decision, failure_kind, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-success", taskId, "plan", "plan", "coder", "complete", "succeeded", "delegate", null, now - 10, now);

    runMigrations(db);

    expect(db.prepare("SELECT failure_count, last_failure_kind, error_text FROM tasks WHERE id = ?").get(taskId)).toMatchObject({
      failure_count: 0,
      last_failure_kind: null,
      error_text: null,
    });
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
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });

  it("refuses a newer schema before performing or relabeling migrations", () => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', '999');
      CREATE TABLE future_only (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO future_only (id, payload) VALUES ('sentinel', 'keep');
    `);

    let error;
    try {
      runMigrations(db);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "schema_too_new",
      databaseSchemaVersion: 999,
      supportedSchemaVersion: SCHEMA_VERSION,
    });
    expect(error.message).toMatch(/upgrade Worklab or restore a backup/i);
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value).toBe("999");
    expect(db.prepare("SELECT payload FROM future_only WHERE id = 'sentinel'").get().payload).toBe("keep");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeUndefined();
  });

  it.each([
    "not-a-version",
    "1.5",
    "-1",
    "9007199254740992",
  ])("refuses invalid schema metadata %j before performing migrations", (storedVersion) => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE future_only (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO future_only (id, payload) VALUES ('sentinel', 'keep');
    `);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(storedVersion);
    const before = schemaSnapshot(db);

    let error;
    try {
      runMigrations(db);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "schema_version_invalid",
      supportedSchemaVersion: SCHEMA_VERSION,
    });
    expect(error.message).toMatch(/schema metadata is invalid/i);
    expect(schemaSnapshot(db)).toEqual(before);
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value)
      .toBe(storedVersion);
    expect(db.prepare("SELECT payload FROM future_only WHERE id = 'sentinel'").get().payload).toBe("keep");
  });

  it("migrates assistant run diagnostics columns", () => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE assistant_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'Personal assistant',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE assistant_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete',
        run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE assistant_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
        user_message_id TEXT REFERENCES assistant_messages(id) ON DELETE SET NULL,
        assistant_message_id TEXT REFERENCES assistant_messages(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'running',
        model TEXT,
        effort TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        summary TEXT,
        final_json TEXT,
        error_text TEXT,
        raw_output_path TEXT
      );
    `);

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(assistant_runs)").all().map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining([
      "failure_kind",
      "cancel_initiator",
      "cancel_reason",
      "warnings_json",
      "diagnostics_json",
    ]));
  });

  it("defaults new agents to allowing self-review and review-only browser tools off", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("default-review", "Default Review", "claude", "claude:claude-sonnet-4-6", now, now);
    const row = db.prepare("SELECT allow_self_review, browser_tools_review_only FROM agents WHERE name = ?").get("default-review");
    expect(row.allow_self_review).toBe(1);
    expect(row.browser_tools_review_only).toBe(0);
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
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        parent_run_id TEXT,
        mode TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'execute',
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        process_status TEXT NOT NULL DEFAULT 'running',
        decision TEXT,
        failure_kind TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        diagnostics_json TEXT
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
      "INSERT INTO task_runs (id, task_id, mode, agent_name, status, process_status, failure_kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("r-failed", "t1", "execute", "legacy-owner", "error", "failed", "spawn", now - 300, now - 250);
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, status, process_status, decision, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("r-rejected", "t1", "review", "legacy-reviewer", "complete", "succeeded", "reject", now - 200, now - 150);
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, status, process_status, started_at, ended_at, diagnostics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("r-cont", "t1", "execute", "legacy-owner", "complete", "succeeded", now - 100, now - 50, JSON.stringify({ continuation_of_run_id: "r-failed" }));
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
    expect(taskCols).not.toContain("retry_count");
    expect(taskCols).toContain("failure_count");
    expect(taskCols).toEqual(expect.arrayContaining([
      "parent_review_policy",
      "rejection_streak",
      "lifetime_failure_count",
      "lifetime_rejection_count",
      "lifetime_recovery_continuation_count",
      "last_failure_kind",
    ]));
    expect(tables).not.toContain("schedules");
    expect(tables).not.toContain("schedule_spawns");
    const taskRow = db.prepare(`
      SELECT id, task_key, title, instructions, stage, owner_agent, root_task_id, run_policy,
             parent_review_policy, lifetime_failure_count, lifetime_rejection_count,
             lifetime_recovery_continuation_count
      FROM tasks WHERE id='t1'
    `).get();
    expect(taskRow).toMatchObject({
      id: "t1",
      task_key: "T-1",
      title: "keep me",
      instructions: "stay",
      stage: "execute",
      owner_agent: "legacy-owner",
      root_task_id: "t1",
      run_policy: "manual",
      parent_review_policy: "default",
      lifetime_failure_count: 1,
      lifetime_rejection_count: 1,
      lifetime_recovery_continuation_count: 1,
    });
    expect(taskCols).toEqual(expect.arrayContaining(["task_key", "stage", "owner_agent", "planner_agent", "parent_task_id", "pending_actions_json", "pending_questions_json", "client_request_id", "plan_body", "run_policy"]));
  });

  it("backfills task keys by creation order and advances the counter", () => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("late", "late", 200, 200);
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("early", "early", 100, 100);

    runMigrations(db);

    expect(db.prepare("SELECT id, task_key FROM tasks ORDER BY created_at ASC, id ASC").all()).toEqual([
      { id: "early", task_key: "T-1" },
      { id: "late", task_key: "T-2" },
    ]);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'task_key_next'").get().value).toBe("3");
  });

  it("allows taskless consolidation runs", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at) VALUES (?, NULL, ?, ?, ?)")
      .run("r1", "consolidate", "alice", Date.now());
    const row = db.prepare("SELECT task_id, mode FROM task_runs WHERE id = 'r1'").get();
    expect(row).toMatchObject({ task_id: null, mode: "consolidate" });
  });

  it("preserves task run metadata while relaxing legacy task_id constraints", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT 'execute',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        parent_run_id TEXT,
        mode TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'execute',
        agent_name TEXT NOT NULL,
        provider_kind TEXT,
        worker_pid INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        process_status TEXT NOT NULL DEFAULT 'running',
        decision TEXT,
        failure_kind TEXT,
        retry_stage TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        error_text TEXT,
        summary TEXT,
        details TEXT,
        raw_output_path TEXT,
        artifact_paths_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT
      );
    `);
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("t1", "partial upgrade", now, now);
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, worker_pid,
        status, process_status, decision, failure_kind, retry_stage,
        started_at, ended_at, exit_code, error_text, summary, details,
        raw_output_path, artifact_paths_json, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "r1", "t1", "execute", "plan", "alice", "openai", 123,
      "error", "failed", "block", "tool_failure", "execute",
      now - 100, now, 2, "boom", "summary", "details",
      "/tmp/raw.log", "[\"artifact.txt\"]", "{\"ok\":false}",
    );

    runMigrations(db);

    const taskIdColumn = db.prepare("PRAGMA table_info(task_runs)").all().find((row) => row.name === "task_id");
    expect(taskIdColumn.notnull).toBe(0);
    const row = db.prepare(`
      SELECT task_id, mode, stage, agent_name, provider_kind, worker_pid,
             status, process_status, decision, failure_kind, retry_stage,
             started_at, ended_at, exit_code, error_text, summary, details,
             raw_output_path, artifact_paths_json, result_json
      FROM task_runs WHERE id = 'r1'
    `).get();
    expect(row).toMatchObject({
      task_id: "t1",
      mode: "execute",
      stage: "plan",
      agent_name: "alice",
      provider_kind: "openai",
      worker_pid: 123,
      status: "error",
      process_status: "failed",
      decision: "block",
      failure_kind: "tool_failure",
      retry_stage: "execute",
      started_at: now - 100,
      ended_at: now,
      exit_code: 2,
      error_text: "boom",
      summary: "summary",
      details: "details",
      raw_output_path: "/tmp/raw.log",
      artifact_paths_json: "[\"artifact.txt\"]",
      result_json: "{\"ok\":false}",
    });
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at) VALUES (?, NULL, ?, ?, ?)")
      .run("automation-run", "automation", "alice", now);
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

  it("canonicalizes legacy active runtime model references on saved agents and settings", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("openai-agent", "OpenAI Agent", "openai", "openai:gpt-5.5", now, now);
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("codex-agent", "Codex Agent", "codex", "codex:gpt-5.5", now, now);
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, execution_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("pi-codex-cli-agent", "Pi Codex CLI Agent", "pi", "pi:openai-codex:gpt-5.5", "cli", now, now);
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("custom-agent", "Custom Agent", "vercel", "vercel:provider-1:gemma3:4b", now, now);
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("claude-code-agent", "Claude Code Agent", "claude-code", "claude-code:claude-sonnet-4-6", now, now);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("slack_model", JSON.stringify("codex:gpt-5.5"));
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("assistant_model", JSON.stringify("openai:gpt-5.5"));

    runMigrations(db);

    expect(db.prepare("SELECT sdk, model FROM agents WHERE name = 'openai-agent'").get())
      .toMatchObject({ sdk: "pi", model: "pi:openai:gpt-5.5" });
    expect(db.prepare("SELECT sdk, model, execution_mode FROM agents WHERE name = 'codex-agent'").get())
      .toMatchObject({ sdk: "codex", model: "codex:gpt-5.5", execution_mode: "cli" });
    expect(db.prepare("SELECT sdk, model, execution_mode FROM agents WHERE name = 'pi-codex-cli-agent'").get())
      .toMatchObject({ sdk: "codex", model: "codex:gpt-5.5", execution_mode: "cli" });
    expect(db.prepare("SELECT sdk, model FROM agents WHERE name = 'custom-agent'").get())
      .toMatchObject({ sdk: "pi", model: "pi:provider-1:gemma3:4b" });
    expect(db.prepare("SELECT sdk, model FROM agents WHERE name = 'claude-code-agent'").get())
      .toMatchObject({ sdk: "claude", model: "claude:claude-sonnet-4-6" });
    expect(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'slack_model'").get().value))
      .toBe("pi:openai-codex:gpt-5.5");
    expect(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'assistant_model'").get().value))
      .toBe("pi:openai:gpt-5.5");
  });

  it("canonicalizes provider-backed embedding and adjudicator references without re-embedding", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("default_embedding_model", JSON.stringify("vercel:lm-studio:text-embedding-bge-m3"));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("agent_verification_adjudicator_model", JSON.stringify("vercel:lm-studio:guard-model"));
    db.prepare(`
      INSERT INTO embeddings
        (id, kind, ref, source_ref, chunk_text, model, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "embedding-legacy",
      "kb",
      "knowledge/example.md#chunk-0",
      "knowledge/example.md#chunk-0",
      "Example",
      "vercel:lm-studio:text-embedding-bge-m3",
      "hash",
      now,
      now,
    );

    runMigrations(db);
    runMigrations(db);

    expect(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?")
      .get("default_embedding_model").value)).toBe("provider:lm-studio:text-embedding-bge-m3");
    expect(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?")
      .get("agent_verification_adjudicator_model").value)).toBe("provider:lm-studio:guard-model");
    expect(db.prepare("SELECT model FROM embeddings WHERE id = ?").get("embedding-legacy").model)
      .toBe("provider:lm-studio:text-embedding-bge-m3");
  });

  it("does not rewrite historical agent log model snapshots during canonical runtime migration", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const now = Date.now();
    const taskId = newTaskId();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(taskId, "audit", now, now);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, status, process_status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("run_legacy", taskId, "execute", "agent", "complete", "succeeded", now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("log_legacy", "run_legacy", "[]", "codex:gpt-5.5", "complete", now);

    runMigrations(db);

    expect(db.prepare("SELECT model FROM agent_logs WHERE id = 'log_legacy'").get().model)
      .toBe("codex:gpt-5.5");
  });
});
