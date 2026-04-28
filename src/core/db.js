import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { legacyRunStatusToProcessStatus, processStatusToLegacyStatus, STAGES } from "./state-machine.js";
import { backfillTaskKeys } from "./task-keys.js";

let singleton = null;

export function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function addColumnIfMissing(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function getColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().find((row) => row.name === column);
}

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?").get(table);
}

function normalizeMigratedTaskStage({ stage, status } = {}) {
  if (stage === "draft") return "plan";
  if (stage === "verify" || stage === "qa") return "review";
  if (STAGES.includes(stage)) return stage;
  switch (status) {
    case "in_review":
      return "review";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "todo":
    case "in_progress":
    default:
      return "execute";
  }
}

function ensureNullableTaskRunsTaskId(db) {
  const taskId = getColumn(db, "task_runs", "task_id");
  if (!taskId || taskId.notnull === 0) return;

  const runColumns = db.prepare("PRAGMA table_info(task_runs)").all().map((row) => row.name);
  const runColumn = (name, fallback = "NULL") => runColumns.includes(name) ? name : fallback;
  const statusExpression = runColumn("status", "'running'");
  const processStatusExpression = runColumns.includes("process_status")
    ? "process_status"
    : `CASE ${statusExpression}
        WHEN 'complete' THEN 'succeeded'
        WHEN 'succeeded' THEN 'succeeded'
        WHEN 'error' THEN 'failed'
        WHEN 'failed' THEN 'failed'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'abandoned' THEN 'abandoned'
        WHEN 'queued' THEN 'queued'
        ELSE 'running'
      END`;
  const stageExpression = runColumns.includes("stage")
    ? "COALESCE(stage, CASE WHEN mode = 'review' THEN 'review' ELSE 'execute' END)"
    : "CASE WHEN mode = 'review' THEN 'review' ELSE 'execute' END";

  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS task_runs_new;
    CREATE TABLE task_runs_new (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      parent_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
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
    INSERT INTO task_runs_new
      (id, task_id, parent_run_id, mode, stage, agent_name, provider_kind, worker_pid,
       status, process_status, decision, failure_kind, retry_stage, started_at, ended_at,
       exit_code, error_text, summary, details, raw_output_path, artifact_paths_json, result_json)
    SELECT id, task_id, ${runColumn("parent_run_id")}, mode, ${stageExpression}, agent_name,
           ${runColumn("provider_kind")}, ${runColumn("worker_pid")}, ${statusExpression},
           ${processStatusExpression}, ${runColumn("decision")}, ${runColumn("failure_kind")},
           ${runColumn("retry_stage")}, ${runColumn("started_at", "0")},
           ${runColumn("ended_at")}, ${runColumn("exit_code")}, ${runColumn("error_text")},
           ${runColumn("summary")}, ${runColumn("details")}, ${runColumn("raw_output_path")},
           ${runColumn("artifact_paths_json", "'[]'")}, ${runColumn("result_json")}
    FROM task_runs;
    DROP TABLE task_runs;
    ALTER TABLE task_runs_new RENAME TO task_runs;
    CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at DESC);
    PRAGMA foreign_keys = ON;
  `);
}

function ensureWorkflowColumns(db) {
  addColumnIfMissing(db, "tasks", "task_key", "task_key TEXT");
  addColumnIfMissing(db, "tasks", "root_task_id", "root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "tasks", "parent_task_id", "parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "tasks", "delegated_by_run_id", "delegated_by_run_id TEXT");
  addColumnIfMissing(db, "tasks", "delegated_to_agent", "delegated_to_agent TEXT REFERENCES agents(name) ON DELETE SET NULL");
  addColumnIfMissing(db, "tasks", "owner_agent", "owner_agent TEXT REFERENCES agents(name) ON DELETE SET NULL");
  addColumnIfMissing(db, "tasks", "planner_agent", "planner_agent TEXT REFERENCES agents(name) ON DELETE SET NULL");
  addColumnIfMissing(db, "tasks", "client_request_id", "client_request_id TEXT");
  addColumnIfMissing(db, "tasks", "stage", "stage TEXT NOT NULL DEFAULT 'plan'");
  addColumnIfMissing(db, "tasks", "stage_reason", "stage_reason TEXT");
  addColumnIfMissing(db, "tasks", "run_policy", "run_policy TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, "tasks", "join_policy", "join_policy TEXT NOT NULL DEFAULT 'all_required'");
  addColumnIfMissing(db, "tasks", "subtask_order", "subtask_order INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "tasks", "required", "required INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "tasks", "pending_actions_json", "pending_actions_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "tasks", "blocking_issues_json", "blocking_issues_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "tasks", "plan_body", "plan_body TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "tasks", "plan_updated_at", "plan_updated_at INTEGER");
  addColumnIfMissing(db, "tasks", "plan_updated_by", "plan_updated_by TEXT");
  addColumnIfMissing(db, "tasks", "plan_source_run_id", "plan_source_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL");

  addColumnIfMissing(db, "task_runs", "parent_run_id", "parent_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "task_runs", "stage", "stage TEXT NOT NULL DEFAULT 'execute'");
  addColumnIfMissing(db, "task_runs", "provider_kind", "provider_kind TEXT");
  addColumnIfMissing(db, "task_runs", "process_status", "process_status TEXT NOT NULL DEFAULT 'running'");
  addColumnIfMissing(db, "task_runs", "decision", "decision TEXT");
  addColumnIfMissing(db, "task_runs", "failure_kind", "failure_kind TEXT");
  addColumnIfMissing(db, "task_runs", "retry_stage", "retry_stage TEXT");
  addColumnIfMissing(db, "task_runs", "summary", "summary TEXT");
  addColumnIfMissing(db, "task_runs", "details", "details TEXT");
  addColumnIfMissing(db, "task_runs", "raw_output_path", "raw_output_path TEXT");
  addColumnIfMissing(db, "task_runs", "artifact_paths_json", "artifact_paths_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "task_runs", "result_json", "result_json TEXT");
}

function normalizeWorkflowState(db) {
  if (tableExists(db, "tasks")) {
    const columns = db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
    const select = [
      "id",
      columns.includes("status") ? "status" : "NULL AS status",
      columns.includes("stage") ? "stage" : "NULL AS stage",
    ].join(", ");
    const taskRows = db.prepare(`SELECT ${select} FROM tasks`).all();
    const updateTask = db.prepare("UPDATE tasks SET stage = ?, root_task_id = COALESCE(root_task_id, id) WHERE id = ?");
    const taskTx = db.transaction(() => {
      for (const row of taskRows) {
        updateTask.run(normalizeMigratedTaskStage(row), row.id);
      }
    });
    taskTx();
  }

  const runRows = db.prepare("SELECT id, status, process_status, mode, stage FROM task_runs").all();
  const updateRun = db.prepare("UPDATE task_runs SET process_status = ?, status = ?, stage = ? WHERE id = ?");
  const runTx = db.transaction(() => {
    for (const row of runRows) {
      const processStatus = row.process_status && row.process_status !== "running"
        ? row.process_status
        : legacyRunStatusToProcessStatus(row.status);
      const stage = row.stage && row.stage !== "execute" ? row.stage : (row.mode === "review" ? "review" : "execute");
      updateRun.run(processStatus, processStatusToLegacyStatus(processStatus), stage, row.id);
    }
  });
  runTx();
}

function resetLegacyEmbeddings(db) {
  const sourceRef = getColumn(db, "embeddings", "source_ref");
  const vector = getColumn(db, "embeddings", "vector");
  if (!tableExists(db, "embeddings") || (sourceRef && vector && vector.notnull === 0)) return;
  db.exec(`
    DROP TABLE IF EXISTS embeddings_fts;
    DROP TABLE IF EXISTS embeddings;
  `);
}

// SQLite doesn't reliably support `ALTER TABLE DROP COLUMN`, so any schema
// cleanup that removes columns rebuilds the table inside a single transaction.
function rebuildTaskWorkflowTables(db) {
  const taskColumns = tableExists(db, "tasks")
    ? db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name)
    : [];
  const taskColumn = (name, fallback = "NULL") => taskColumns.includes(name) ? name : fallback;
  const ownerExpression = taskColumns.includes("owner_agent") && taskColumns.includes("executor_agent")
    ? "COALESCE(owner_agent, executor_agent)"
    : taskColumn("owner_agent", taskColumn("executor_agent"));
  const stageExpression = (() => {
    if (taskColumns.includes("stage") && taskColumns.includes("status")) {
      return `CASE
          WHEN stage = 'draft' THEN 'plan'
          WHEN stage IN ('verify', 'qa') THEN 'review'
          WHEN stage IN ('plan', 'execute', 'review', 'awaiting_children', 'awaiting_user', 'blocked', 'done') THEN stage
          WHEN status = 'in_review' THEN 'review'
          WHEN status = 'done' THEN 'done'
          WHEN status = 'blocked' THEN 'blocked'
          ELSE 'execute'
        END`;
    }
    if (taskColumns.includes("stage")) {
      return `CASE
          WHEN stage = 'draft' THEN 'plan'
          WHEN stage IN ('verify', 'qa') THEN 'review'
          WHEN stage IN ('plan', 'execute', 'review', 'awaiting_children', 'awaiting_user', 'blocked', 'done') THEN stage
          ELSE 'execute'
        END`;
    }
    if (taskColumns.includes("status")) {
      return `CASE
          WHEN status = 'in_review' THEN 'review'
          WHEN status = 'done' THEN 'done'
          WHEN status = 'blocked' THEN 'blocked'
          ELSE 'execute'
        END`;
    }
    return "'execute'";
  })();
  const tasksHasLegacy = taskColumns.includes("priority")
    || taskColumns.includes("description")
    || taskColumns.includes("status")
    || taskColumns.includes("executor_agent")
    || taskColumns.includes("source_schedule_id");
  if (tasksHasLegacy) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE tasks__new (
        id TEXT PRIMARY KEY,
        task_key TEXT,
        root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        delegated_by_run_id TEXT,
        delegated_to_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        owner_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        planner_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        client_request_id TEXT,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT 'plan',
        stage_reason TEXT,
        run_policy TEXT NOT NULL DEFAULT 'auto_plan_execute',
        join_policy TEXT NOT NULL DEFAULT 'all_required',
        subtask_order INTEGER NOT NULL DEFAULT 0,
        required INTEGER NOT NULL DEFAULT 1,
        pending_actions_json TEXT NOT NULL DEFAULT '[]',
        blocking_issues_json TEXT NOT NULL DEFAULT '[]',
        plan_body TEXT NOT NULL DEFAULT '',
        plan_updated_at INTEGER,
        plan_updated_by TEXT,
        plan_source_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
        reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        error_text TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      INSERT INTO tasks__new (
        id, task_key, root_task_id, parent_task_id, delegated_by_run_id, delegated_to_agent, owner_agent, planner_agent,
        client_request_id, title, instructions, stage, stage_reason, run_policy, join_policy, subtask_order, required,
        pending_actions_json, blocking_issues_json, plan_body, plan_updated_at, plan_updated_by,
        plan_source_run_id, reviewer_agent, tags,
        error_text, retry_count, created_at, updated_at, completed_at
      )
      SELECT
        id,
        ${taskColumn("task_key")},
        COALESCE(root_task_id, id),
        parent_task_id,
        delegated_by_run_id,
        delegated_to_agent,
        ${ownerExpression},
        ${taskColumn("planner_agent")},
        client_request_id,
        title,
        instructions,
        ${stageExpression},
        stage_reason,
        ${taskColumn("run_policy", "'manual'")},
        join_policy,
        subtask_order,
        required,
        pending_actions_json,
        blocking_issues_json,
        ${taskColumn("plan_body", "''")},
        ${taskColumn("plan_updated_at")},
        ${taskColumn("plan_updated_by")},
        ${taskColumn("plan_source_run_id")},
        reviewer_agent,
        tags,
        error_text, retry_count, created_at, updated_at, completed_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks__new RENAME TO tasks;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_task_key ON tasks(task_key) WHERE task_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, subtask_order);
      CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_task_id, updated_at DESC);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
}

export function runMigrations(db) {
  // Existing pre-v8 databases may have `tasks` but not `stage`; SCHEMA_SQL
  // creates an index on stage, so add the column before executing the full
  // schema block.
  if (tableExists(db, "tasks")) {
    addColumnIfMissing(db, "tasks", "stage", "stage TEXT");
    addColumnIfMissing(db, "tasks", "task_key", "task_key TEXT");
  }
  if (tableExists(db, "automations")) {
    addColumnIfMissing(db, "automations", "task_id", "task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE");
  }
  db.exec(SCHEMA_SQL);
  ensureNullableTaskRunsTaskId(db);
  ensureWorkflowColumns(db);
  addColumnIfMissing(db, "tasks", "task_key", "task_key TEXT");
  addColumnIfMissing(db, "tasks", "client_request_id", "client_request_id TEXT");
  addColumnIfMissing(db, "agents", "skills_allowlist_mode", "skills_allowlist_mode TEXT NOT NULL DEFAULT 'all'");
  addColumnIfMissing(db, "agents", "mcp_allowlist_mode", "mcp_allowlist_mode TEXT NOT NULL DEFAULT 'all'");
  addColumnIfMissing(db, "agents", "builtin_allowlist_mode", "builtin_allowlist_mode TEXT NOT NULL DEFAULT 'all'");
  addColumnIfMissing(db, "custom_providers", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "custom_models", "display_name", "display_name TEXT");
  addColumnIfMissing(db, "custom_models", "capabilities_json", "capabilities_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "custom_models", "pricing_json", "pricing_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "custom_models", "discovered_at", "discovered_at INTEGER");
  addColumnIfMissing(db, "automations", "task_id", "task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_task_key ON tasks(task_key) WHERE task_key IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id ON tasks(client_request_id) WHERE client_request_id IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage, updated_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, subtask_order)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_task_id, updated_at DESC)");
  db.exec("CREATE TABLE IF NOT EXISTS task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, depends_on_task_id))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id)");
  db.exec("CREATE TABLE IF NOT EXISTS task_edges (parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, edge_type TEXT NOT NULL DEFAULT 'subtask', required INTEGER NOT NULL DEFAULT 1, created_by_run_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (parent_task_id, child_task_id, edge_type))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_edges_parent ON task_edges(parent_task_id, edge_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_edges_child ON task_edges(child_task_id, edge_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_process ON task_runs(process_status, started_at DESC)");
  db.exec("CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', agent_name TEXT REFERENCES agents(name) ON DELETE SET NULL, tags TEXT NOT NULL DEFAULT '[]', trigger_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, next_fire_at INTEGER, last_fired_at INTEGER, last_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL, last_status TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automations_enabled_next_fire ON automations(enabled, next_fire_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automations_task ON automations(task_id, updated_at DESC)");
  db.exec("CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE, trigger_type TEXT NOT NULL DEFAULT 'manual', fired_at INTEGER NOT NULL, UNIQUE(run_id))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, fired_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automation_runs_run ON automation_runs(run_id)");
  db.exec("CREATE TABLE IF NOT EXISTS automation_triggers (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL, trigger_type TEXT NOT NULL DEFAULT 'manual', outcome TEXT NOT NULL, reason TEXT, fired_at INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automation_triggers_automation ON automation_triggers(automation_id, fired_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automation_triggers_task ON automation_triggers(task_id, fired_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_automation_triggers_run ON automation_triggers(run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_enabled ON custom_models(enabled, provider_id)");
  resetLegacyEmbeddings(db);
  normalizeWorkflowState(db);
  rebuildTaskWorkflowTables(db);
  db.exec("DROP TABLE IF EXISTS schedule_spawns");
  db.exec("DROP TABLE IF EXISTS schedules");
  db.exec(SCHEMA_SQL);
  normalizeWorkflowState(db);
  backfillTaskKeys(db);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_task_key ON tasks(task_key) WHERE task_key IS NOT NULL");
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
}

export function getDb(path) {
  if (singleton) return singleton;
  singleton = openDb(path);
  runMigrations(singleton);
  return singleton;
}

export function closeDb() {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
