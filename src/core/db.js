import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

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

function ensureNullableTaskRunsTaskId(db) {
  const taskId = getColumn(db, "task_runs", "task_id");
  if (!taskId || taskId.notnull === 0) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE IF NOT EXISTS task_runs_new (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      worker_pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      error_text TEXT
    );
    INSERT INTO task_runs_new
      (id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at, exit_code, error_text)
    SELECT id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at, exit_code, error_text
    FROM task_runs;
    DROP TABLE task_runs;
    ALTER TABLE task_runs_new RENAME TO task_runs;
    CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at DESC);
    PRAGMA foreign_keys = ON;
  `);
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

// Schema v5 — drop priority + description from tasks and schedules.
// SQLite doesn't reliably support `ALTER TABLE DROP COLUMN`, so rebuild the
// table inside a single transaction. Only runs when the legacy columns are
// still present.
function dropPriorityAndDescription(db) {
  const tasksHasLegacy = hasColumn(db, "tasks", "priority") || hasColumn(db, "tasks", "description");
  if (tasksHasLegacy) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE tasks__new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        executor_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        error_text TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        source_schedule_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      INSERT INTO tasks__new (
        id, title, instructions, status, executor_agent, reviewer_agent, tags,
        error_text, retry_count, source_schedule_id, created_at, updated_at, completed_at
      )
      SELECT
        id, title, instructions, status, executor_agent, reviewer_agent, tags,
        error_text, retry_count, source_schedule_id, created_at, updated_at, completed_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks__new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id, created_at DESC);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const schedulesHasLegacy = tableExists(db, "schedules")
    && (hasColumn(db, "schedules", "priority") || hasColumn(db, "schedules", "description"));
  if (schedulesHasLegacy) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE schedules__new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        executor_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        cadence_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at INTEGER,
        last_fired_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schedules__new (
        id, title, instructions, executor_agent, reviewer_agent, tags,
        cadence_json, enabled, next_fire_at, last_fired_at, created_at, updated_at
      )
      SELECT
        id, title, instructions, executor_agent, reviewer_agent, tags,
        cadence_json, enabled, next_fire_at, last_fired_at, created_at, updated_at
      FROM schedules;
      DROP TABLE schedules;
      ALTER TABLE schedules__new RENAME TO schedules;
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next_fire ON schedules(enabled, next_fire_at);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
}

export function runMigrations(db) {
  db.exec(SCHEMA_SQL);
  ensureNullableTaskRunsTaskId(db);
  addColumnIfMissing(db, "tasks", "source_schedule_id", "source_schedule_id TEXT");
  addColumnIfMissing(db, "custom_providers", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "custom_models", "display_name", "display_name TEXT");
  addColumnIfMissing(db, "custom_models", "capabilities_json", "capabilities_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "custom_models", "pricing_json", "pricing_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "custom_models", "discovered_at", "discovered_at INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule ON tasks(source_schedule_id, created_at DESC)");
  db.exec("CREATE TABLE IF NOT EXISTS task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, depends_on_task_id))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id)");
  db.exec("CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', executor_agent TEXT REFERENCES agents(name) ON DELETE SET NULL, reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL, tags TEXT NOT NULL DEFAULT '[]', cadence_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, next_fire_at INTEGER, last_fired_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next_fire ON schedules(enabled, next_fire_at)");
  db.exec("CREATE TABLE IF NOT EXISTS schedule_spawns (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, trigger_type TEXT NOT NULL DEFAULT 'manual', fired_at INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_schedule_spawns_schedule ON schedule_spawns(schedule_id, fired_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_schedule_spawns_task ON schedule_spawns(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_enabled ON custom_models(enabled, provider_id)");
  resetLegacyEmbeddings(db);
  dropPriorityAndDescription(db);
  db.exec(SCHEMA_SQL);
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
