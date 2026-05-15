export const SCHEMA_VERSION = 46;

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
  context_window TEXT NOT NULL DEFAULT 'default',
  fast_mode INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '',
  skills_allowlist TEXT NOT NULL DEFAULT '[]',
  skills_allowlist_mode TEXT NOT NULL DEFAULT 'all',
  mcp_allowlist TEXT NOT NULL DEFAULT '[]',
  mcp_allowlist_mode TEXT NOT NULL DEFAULT 'all',
  builtin_allowlist TEXT NOT NULL DEFAULT '[]',
  builtin_allowlist_mode TEXT NOT NULL DEFAULT 'all',
  allow_self_review INTEGER NOT NULL DEFAULT 1,
  browser_tools_review_only INTEGER NOT NULL DEFAULT 0,
  subagent_mode TEXT NOT NULL DEFAULT 'advisory',
  execution_mode TEXT NOT NULL DEFAULT 'sdk',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- HITL approval (v46). When require_human_approval=1, the worker installs
  -- onToolApprovalRequest and tools resolve via tool_risk_tiers_json
  -- (mapping toolName → low|medium|high). Low auto-approves; medium calls
  -- the host; high requires the host (deny if no callback).
  require_human_approval INTEGER NOT NULL DEFAULT 0,
  tool_risk_tiers_json TEXT NOT NULL DEFAULT '{}',
  approval_timeout_ms INTEGER NOT NULL DEFAULT 300000,
  -- Fallback chain (v46). When non-empty, generateResponse routes through
  -- createRouterRuntime with this chain prepended by the primary model.
  fallback_chain_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  lead_agent TEXT REFERENCES agents(name) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_interval_minutes INTEGER,
  daily_budget_usd REAL,
  per_run_budget_usd REAL,
  last_lead_cycle_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_status_updated ON teams(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  role_description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_team_members_agent ON team_members(agent_name);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  context_markdown TEXT NOT NULL DEFAULT '',
  workdir TEXT,
  worktree_mode TEXT NOT NULL DEFAULT 'off',
  tags_json TEXT NOT NULL DEFAULT '[]',
  team_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_archived_updated ON projects(archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  task_key TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  is_team_root INTEGER NOT NULL DEFAULT 0,
  goal_status TEXT,
  goal_status_reason TEXT,
  goal_contract_json TEXT NOT NULL DEFAULT '{}',
  last_lead_at INTEGER,
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
  pending_questions_json TEXT NOT NULL DEFAULT '[]',
  blocking_issues_json TEXT NOT NULL DEFAULT '[]',
  plan_body TEXT NOT NULL DEFAULT '',
  plan_updated_at INTEGER,
  plan_updated_by TEXT,
  plan_source_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  parent_review_policy TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  error_text TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  rejection_streak INTEGER NOT NULL DEFAULT 0,
  lifetime_failure_count INTEGER NOT NULL DEFAULT 0,
  lifetime_rejection_count INTEGER NOT NULL DEFAULT 0,
  lifetime_recovery_continuation_count INTEGER NOT NULL DEFAULT 0,
  last_failure_kind TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_task_key ON tasks(task_key) WHERE task_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project_stage ON tasks(project_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_visible_updated ON tasks(is_team_root, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, subtask_order);
CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_task_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_team_root_unique ON tasks(team_id, project_id) WHERE is_team_root = 1;
CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id) WHERE team_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES task_comments(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'path',
  label TEXT NOT NULL DEFAULT '',
  path_text TEXT,
  absolute_path TEXT,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  stored_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task_owner ON task_attachments(task_id, owner_type, created_at);
CREATE INDEX IF NOT EXISTS idx_task_attachments_comment ON task_attachments(comment_id, created_at) WHERE comment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  parent_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  parent_relationship TEXT,
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
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  artifact_summary_json TEXT NOT NULL DEFAULT '{}',
  todo_state_json TEXT NOT NULL DEFAULT '{"todos":[],"updated_at":null,"update_count":0}',
  result_json TEXT,
  cancel_initiator TEXT,
  cancel_reason TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  diagnostics_json TEXT,
  provider_session_id TEXT,
  execenv_path TEXT,
  workdir TEXT,
  workspace_mode TEXT NOT NULL DEFAULT 'direct',
  source_workdir TEXT,
  worktree_json TEXT,
  project_context_hash TEXT,
  cost_usd REAL,
  transcript_tail_json TEXT,
  first_turn_input_tokens INTEGER,
  first_turn_overhead_tokens INTEGER,
  capabilities_used_json TEXT,
  failover_history_json TEXT,
  tool_usage_summary_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_task_status_started ON task_runs(task_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_agent_started ON task_runs(agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON task_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started_cost_summary ON task_runs(started_at DESC, agent_name, cost_usd, status, process_status);
CREATE INDEX IF NOT EXISTS idx_runs_team_kind ON task_runs(team_id, kind, started_at DESC) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_kind_status ON task_runs(kind, process_status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_process ON task_runs(process_status, started_at DESC);

-- v46: HITL approval audit trail. One row per onToolApprovalRequest call.
-- Status flows pending -> (approved|denied|expired|always). decided_at and
-- decided_by are NULL until the user (or the timeout watchdog) settles the
-- request. The decision mirrors the package ApprovalResponse
-- (approve | deny | always).
CREATE TABLE IF NOT EXISTS task_run_approvals (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  arguments_summary TEXT NOT NULL DEFAULT '',
  risk_tier TEXT NOT NULL DEFAULT 'medium',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  reason TEXT,
  decided_by TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE(task_run_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_approvals_run_status ON task_run_approvals(task_run_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON task_run_approvals(status, requested_at DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  status_reason TEXT,
  contract_json TEXT NOT NULL DEFAULT '{}',
  last_lead_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_goals_team_project ON goals(team_id, project_id);
CREATE INDEX IF NOT EXISTS idx_goals_status_updated ON goals(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_root_task ON goals(root_task_id) WHERE root_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_cycles (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  run_id TEXT UNIQUE REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT 'manual',
  process_status TEXT NOT NULL DEFAULT 'queued',
  status TEXT NOT NULL DEFAULT 'running',
  failure_kind TEXT,
  error_text TEXT,
  goal_status TEXT,
  goal_status_reason TEXT,
  summary TEXT,
  checkpoint_note TEXT,
  validation_summary TEXT,
  task_creations_json TEXT NOT NULL DEFAULT '[]',
  task_assignments_json TEXT NOT NULL DEFAULT '[]',
  task_deletions_json TEXT NOT NULL DEFAULT '[]',
  task_creation_skips_json TEXT NOT NULL DEFAULT '[]',
  goal_refinement_json TEXT NOT NULL DEFAULT '{}',
  goal_refinement_applied_json TEXT NOT NULL DEFAULT '{}',
  advisory_notes_json TEXT NOT NULL DEFAULT '[]',
  next_review_hint_json TEXT NOT NULL DEFAULT '{}',
  next_review_due_at INTEGER,
  next_review_event TEXT,
  next_review_consumed_at INTEGER,
  tasks_created INTEGER NOT NULL DEFAULT 0,
  tasks_assigned INTEGER NOT NULL DEFAULT 0,
  tasks_deleted INTEGER NOT NULL DEFAULT 0,
  tasks_skipped INTEGER NOT NULL DEFAULT 0,
  notes_posted INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_cycles_goal_started ON lead_cycles(goal_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_cycles_team_project_started ON lead_cycles(team_id, project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_cycles_due ON lead_cycles(next_review_due_at, next_review_consumed_at)
  WHERE next_review_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_cycles_event ON lead_cycles(team_id, project_id, next_review_event, next_review_consumed_at)
  WHERE next_review_event IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_cycles_run ON lead_cycles(run_id) WHERE run_id IS NOT NULL;

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
  created_at INTEGER NOT NULL,
  events_compacted_at INTEGER,
  events_original_count INTEGER,
  events_original_bytes INTEGER,
  events_compaction_strategy TEXT,
  events_compaction_version INTEGER,
  events_compacted_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON agent_logs(task_run_id);
CREATE INDEX IF NOT EXISTS idx_logs_run_summary
  ON agent_logs(task_run_id, id, model, effort, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms,
                num_turns, status);

CREATE TABLE IF NOT EXISTS run_compactions (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  provider_kind TEXT,
  model TEXT,
  tokens_before INTEGER,
  tokens_after INTEGER,
  chars_before INTEGER,
  chars_after INTEGER,
  first_kept_index INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'succeeded',
  error_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_compactions_run_seq ON run_compactions(task_run_id, seq);

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
  vector_present INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_embeddings_vector_present ON embeddings(vector_present);

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

CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL,
  content_key TEXT NOT NULL,
  evidence TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  supersedes_id TEXT REFERENCES agent_memories(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status ON agent_memories(agent_name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories(scope, project_id, task_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_run ON agent_memories(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_active_dedupe
  ON agent_memories(agent_name, kind, scope, content_key)
  WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  agent_name TEXT REFERENCES agents(name) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  trigger_json TEXT NOT NULL DEFAULT '{}',
  webhook_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at INTEGER,
  last_fired_at INTEGER,
  last_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  last_status TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_enabled_next_fire ON automations(enabled, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_automations_task ON automations(task_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_webhook_id_unique ON automations(webhook_id) WHERE webhook_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  fired_at INTEGER NOT NULL,
  UNIQUE(run_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_run ON automation_runs(run_id);

CREATE TABLE IF NOT EXISTS automation_triggers (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  outcome TEXT NOT NULL,
  reason TEXT,
  fired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_automation ON automation_triggers(automation_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_task ON automation_triggers(task_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_run ON automation_triggers(run_id);

CREATE TABLE IF NOT EXISTS slack_inbound_events (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  user_id TEXT,
  thread_ts TEXT,
  message_ts TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  error_text TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_slack_inbound_received ON slack_inbound_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_inbound_status ON slack_inbound_events(status, received_at);

CREATE TABLE IF NOT EXISTS slack_triage_runs (
  id TEXT PRIMARY KEY,
  inbound_event_id TEXT NOT NULL REFERENCES slack_inbound_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_slack_triage_event ON slack_triage_runs(inbound_event_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_triage_status ON slack_triage_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_triage_started ON slack_triage_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS slack_agent_logs (
  id TEXT PRIMARY KEY,
  slack_triage_run_id TEXT NOT NULL REFERENCES slack_triage_runs(id) ON DELETE CASCADE,
  events TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_agent_logs_run ON slack_agent_logs(slack_triage_run_id);

CREATE TABLE IF NOT EXISTS slack_delivery_log (
  id TEXT PRIMARY KEY,
  slack_triage_run_id TEXT REFERENCES slack_triage_runs(id) ON DELETE SET NULL,
  inbound_event_id TEXT REFERENCES slack_inbound_events(id) ON DELETE SET NULL,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  channel_id TEXT,
  user_id TEXT,
  thread_ts TEXT,
  message_ts TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  error_text TEXT,
  response_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_delivery_run ON slack_delivery_log(slack_triage_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_delivery_task_run ON slack_delivery_log(task_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_delivery_created ON slack_delivery_log(created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Personal assistant',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete',
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_run ON assistant_messages(run_id);

CREATE TABLE IF NOT EXISTS assistant_runs (
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
  failure_kind TEXT,
  error_text TEXT,
  raw_output_path TEXT,
  cancel_initiator TEXT,
  cancel_reason TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  diagnostics_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_thread ON assistant_runs(thread_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_status ON assistant_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS assistant_agent_logs (
  id TEXT PRIMARY KEY,
  assistant_run_id TEXT NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
  events TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_agent_logs_run ON assistant_agent_logs(assistant_run_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  expiration_time INTEGER,
  user_agent TEXT NOT NULL DEFAULT '',
  client_kind TEXT NOT NULL DEFAULT 'pwa',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  disabled_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active ON push_subscriptions(disabled_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
