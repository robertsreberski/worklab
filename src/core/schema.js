export const SCHEMA_VERSION = 7;

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
  root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  delegated_by_run_id TEXT,
  delegated_to_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  owner_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  client_request_id TEXT,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  stage TEXT NOT NULL DEFAULT 'execute',
  stage_reason TEXT,
  join_policy TEXT NOT NULL DEFAULT 'all_required',
  subtask_order INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1,
  pending_actions_json TEXT NOT NULL DEFAULT '[]',
  blocking_issues_json TEXT NOT NULL DEFAULT '[]',
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
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS task_edges (
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL DEFAULT 'subtask',
  required INTEGER NOT NULL DEFAULT 1,
  created_by_run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (parent_task_id, child_task_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_task_edges_parent ON task_edges(parent_task_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_task_edges_child ON task_edges(child_task_id, edge_type);

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

CREATE TABLE IF NOT EXISTS schedules (
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
CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next_fire ON schedules(enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS schedule_spawns (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  fired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_spawns_schedule ON schedule_spawns(schedule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_spawns_task ON schedule_spawns(task_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
