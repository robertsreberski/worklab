function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function addColumnIfMissing(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?").get(table);
}

function ensureColumns(db, table, columns) {
  if (!tableExists(db, table)) return;
  for (const [column, ddl] of columns) {
    addColumnIfMissing(db, table, column, ddl);
  }
}

export function ensureCurrentSchemaColumnsBeforeSchema(db) {
  ensureColumns(db, "teams", [
    ["status", "status TEXT NOT NULL DEFAULT 'active'"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "projects", [
    ["team_id", "team_id TEXT"],
    ["archived", "archived INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "tasks", [
    ["task_key", "task_key TEXT"],
    ["client_request_id", "client_request_id TEXT"],
    ["project_id", "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL"],
    ["team_id", "team_id TEXT REFERENCES teams(id) ON DELETE SET NULL"],
    ["is_team_root", "is_team_root INTEGER NOT NULL DEFAULT 0"],
    ["stage", "stage TEXT NOT NULL DEFAULT 'plan'"],
    ["parent_task_id", "parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL"],
    ["root_task_id", "root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL"],
    ["subtask_order", "subtask_order INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "task_runs", [
    ["task_id", "task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE"],
    ["project_id", "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL"],
    ["team_id", "team_id TEXT REFERENCES teams(id) ON DELETE SET NULL"],
    ["kind", "kind TEXT NOT NULL DEFAULT 'task'"],
    ["agent_name", "agent_name TEXT NOT NULL DEFAULT ''"],
    ["status", "status TEXT NOT NULL DEFAULT 'running'"],
    ["process_status", "process_status TEXT NOT NULL DEFAULT 'running'"],
    ["started_at", "started_at INTEGER NOT NULL DEFAULT 0"],
    ["cost_usd", "cost_usd REAL"],
  ]);
  ensureColumns(db, "goals", [
    ["team_id", "team_id TEXT"],
    ["project_id", "project_id TEXT"],
    ["root_task_id", "root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL"],
    ["status", "status TEXT NOT NULL DEFAULT 'in_progress'"],
    ["status_reason", "status_reason TEXT"],
    ["contract_json", "contract_json TEXT NOT NULL DEFAULT '{}'"],
    ["last_lead_at", "last_lead_at INTEGER"],
    ["created_at", "created_at INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "lead_cycles", [
    ["goal_id", "goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL"],
    ["run_id", "run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE"],
    ["task_id", "task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL"],
    ["team_id", "team_id TEXT REFERENCES teams(id) ON DELETE SET NULL"],
    ["project_id", "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL"],
    ["reason", "reason TEXT NOT NULL DEFAULT 'manual'"],
    ["process_status", "process_status TEXT NOT NULL DEFAULT 'queued'"],
    ["status", "status TEXT NOT NULL DEFAULT 'running'"],
    ["failure_kind", "failure_kind TEXT"],
    ["error_text", "error_text TEXT"],
    ["goal_status", "goal_status TEXT"],
    ["goal_status_reason", "goal_status_reason TEXT"],
    ["summary", "summary TEXT"],
    ["checkpoint_note", "checkpoint_note TEXT"],
    ["validation_summary", "validation_summary TEXT"],
    ["task_creations_json", "task_creations_json TEXT NOT NULL DEFAULT '[]'"],
    ["task_assignments_json", "task_assignments_json TEXT NOT NULL DEFAULT '[]'"],
    ["task_deletions_json", "task_deletions_json TEXT NOT NULL DEFAULT '[]'"],
    ["task_creation_skips_json", "task_creation_skips_json TEXT NOT NULL DEFAULT '[]'"],
    ["goal_refinement_json", "goal_refinement_json TEXT NOT NULL DEFAULT '{}'"],
    ["goal_refinement_applied_json", "goal_refinement_applied_json TEXT NOT NULL DEFAULT '{}'"],
    ["advisory_notes_json", "advisory_notes_json TEXT NOT NULL DEFAULT '[]'"],
    ["next_review_hint_json", "next_review_hint_json TEXT NOT NULL DEFAULT '{}'"],
    ["started_at", "started_at INTEGER"],
    ["ended_at", "ended_at INTEGER"],
    ["next_review_due_at", "next_review_due_at INTEGER"],
    ["next_review_event", "next_review_event TEXT"],
    ["next_review_consumed_at", "next_review_consumed_at INTEGER"],
    ["tasks_created", "tasks_created INTEGER NOT NULL DEFAULT 0"],
    ["tasks_assigned", "tasks_assigned INTEGER NOT NULL DEFAULT 0"],
    ["tasks_deleted", "tasks_deleted INTEGER NOT NULL DEFAULT 0"],
    ["tasks_skipped", "tasks_skipped INTEGER NOT NULL DEFAULT 0"],
    ["notes_posted", "notes_posted INTEGER NOT NULL DEFAULT 0"],
    ["cost_usd", "cost_usd REAL"],
    ["created_at", "created_at INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "agent_logs", [
    ["task_run_id", "task_run_id TEXT"],
    ["model", "model TEXT"],
    ["effort", "effort TEXT"],
    ["input_tokens", "input_tokens INTEGER"],
    ["output_tokens", "output_tokens INTEGER"],
    ["cache_read_tokens", "cache_read_tokens INTEGER"],
    ["cache_creation_tokens", "cache_creation_tokens INTEGER"],
    ["cost_usd", "cost_usd REAL"],
    ["duration_ms", "duration_ms INTEGER"],
    ["num_turns", "num_turns INTEGER"],
    ["status", "status TEXT NOT NULL DEFAULT 'complete'"],
  ]);
  ensureColumns(db, "custom_models", [
    ["provider_id", "provider_id TEXT"],
    ["enabled", "enabled INTEGER NOT NULL DEFAULT 1"],
  ]);
  ensureColumns(db, "embeddings", [
    ["kind", "kind TEXT NOT NULL DEFAULT ''"],
    ["source_ref", "source_ref TEXT NOT NULL DEFAULT ''"],
    ["agent", "agent TEXT"],
  ]);
  ensureColumns(db, "automations", [
    ["enabled", "enabled INTEGER NOT NULL DEFAULT 1"],
    ["next_fire_at", "next_fire_at INTEGER"],
    ["task_id", "task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE"],
    ["webhook_id", "webhook_id TEXT"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "automation_runs", [
    ["automation_id", "automation_id TEXT"],
    ["run_id", "run_id TEXT"],
    ["fired_at", "fired_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "automation_triggers", [
    ["automation_id", "automation_id TEXT"],
    ["task_id", "task_id TEXT"],
    ["run_id", "run_id TEXT"],
    ["fired_at", "fired_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "assistant_messages", [
    ["thread_id", "thread_id TEXT"],
    ["created_at", "created_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "assistant_runs", [
    ["thread_id", "thread_id TEXT"],
    ["status", "status TEXT NOT NULL DEFAULT 'running'"],
    ["started_at", "started_at INTEGER NOT NULL DEFAULT 0"],
  ]);
  ensureColumns(db, "assistant_agent_logs", [
    ["assistant_run_id", "assistant_run_id TEXT"],
  ]);
  ensureColumns(db, "agent_memories", [
    ["agent_name", "agent_name TEXT"],
    ["status", "status TEXT NOT NULL DEFAULT 'draft'"],
    ["scope", "scope TEXT NOT NULL DEFAULT 'agent'"],
    ["project_id", "project_id TEXT"],
    ["task_id", "task_id TEXT"],
    ["run_id", "run_id TEXT"],
    ["updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"],
    ["kind", "kind TEXT NOT NULL DEFAULT 'note'"],
    ["content_key", "content_key TEXT NOT NULL DEFAULT ''"],
  ]);
}
