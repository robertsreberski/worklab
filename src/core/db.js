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

export function runMigrations(db) {
  db.exec(SCHEMA_SQL);
  ensureNullableTaskRunsTaskId(db);
  addColumnIfMissing(db, "custom_providers", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "custom_models", "display_name", "display_name TEXT");
  addColumnIfMissing(db, "custom_models", "capabilities_json", "capabilities_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "custom_models", "pricing_json", "pricing_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "custom_models", "discovered_at", "discovered_at INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_enabled ON custom_models(enabled, provider_id)");
  resetLegacyEmbeddings(db);
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
