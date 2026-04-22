export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  sdk TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  instructions TEXT NOT NULL DEFAULT '',
  skills_allowlist TEXT NOT NULL DEFAULT '[]',
  mcp_allowlist TEXT NOT NULL DEFAULT '[]',
  builtin_allowlist TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  executor_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  error_text TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_runs (
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
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  events TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  num_turns INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON agent_logs(task_run_id);

CREATE TABLE IF NOT EXISTS custom_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT,
  trust_public_url INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES custom_providers(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  alias TEXT,
  display_name TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  pricing_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  discovered_at INTEGER,
  UNIQUE(provider_id, model_name)
);
CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_custom_models_enabled ON custom_models(enabled, provider_id);

CREATE TABLE IF NOT EXISTS embeddings (
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
CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
CREATE INDEX IF NOT EXISTS idx_embeddings_source_ref ON embeddings(kind, source_ref);
CREATE INDEX IF NOT EXISTS idx_embeddings_agent ON embeddings(kind, agent);

CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_fts USING fts5(
  id UNINDEXED,
  kind,
  source_ref,
  title,
  chunk_text
);

CREATE TABLE IF NOT EXISTS agent_consolidations (
  agent_name TEXT PRIMARY KEY REFERENCES agents(name) ON DELETE CASCADE,
  last_journal_hash TEXT,
  last_consolidated_at INTEGER,
  last_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
