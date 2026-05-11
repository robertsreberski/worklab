// Tasks-table queries. Every SELECT/INSERT/UPDATE/DELETE against the `tasks`
// table should land here so callers don't reinvent SQL or scatter prepared
// statements. Phase 2 extracts the most repeated patterns first; bespoke
// SQL stays inline at call sites until the next pass.

export function getTaskById(db, id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function getTaskCoreFields(db, id) {
  return db.prepare(
    "SELECT id, stage, owner_agent, planner_agent, reviewer_agent, parent_task_id, root_task_id, run_policy FROM tasks WHERE id = ?",
  ).get(id);
}

export function getTaskStage(db, id) {
  return db.prepare("SELECT stage FROM tasks WHERE id = ?").get(id);
}

export function listSubtaskIds(db, parentTaskId) {
  return db
    .prepare("SELECT id FROM tasks WHERE parent_task_id = ? ORDER BY subtask_order ASC, created_at ASC")
    .all(parentTaskId)
    .map((row) => row.id);
}

export function countOpenChildren(db, parentTaskId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND stage NOT IN ('done', 'blocked')",
    )
    .get(parentTaskId).n;
}

export function setTaskStage(db, id, stage, updatedAt) {
  db.prepare("UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?").run(stage, updatedAt, id);
}

export function setTaskStageReason(db, id, reason, updatedAt) {
  db.prepare("UPDATE tasks SET stage_reason = ?, updated_at = ? WHERE id = ?").run(reason, updatedAt, id);
}

export function listTaskHeadersForKbUsage(db) {
  return db.prepare("SELECT id, task_key, title, instructions, stage FROM tasks").all();
}

export function getTaskHeaderForKbUsage(db, id) {
  return db.prepare("SELECT id, task_key, title, stage FROM tasks WHERE id = ?").get(id);
}

export function countTasksByStageForProject(db, projectId) {
  return db
    .prepare(
      "SELECT stage, COUNT(*) AS count FROM tasks WHERE project_id = ? AND is_team_root = 0 GROUP BY stage",
    )
    .all(projectId);
}

// Project-detail page: tasks with their unresolved-dependency count and
// running/last run snapshots. Two correlated subqueries pin the most-recent
// running and most-recent non-running run per task; the dependency subquery
// counts open dependencies.
export function getTaskTitle(db, id) {
  return db.prepare("SELECT title FROM tasks WHERE id = ?").get(id)?.title || null;
}

export function getTaskKeyById(db, id) {
  return db.prepare("SELECT task_key FROM tasks WHERE id = ?").get(id)?.task_key || null;
}

export function getTaskByKey(db, taskKey) {
  return db.prepare("SELECT * FROM tasks WHERE task_key = ?").get(taskKey);
}

export function listTasksByTitlePrefix(db, query, limit) {
  const q = String(query || "").trim();
  if (!q) return [];
  const escaped = q.replace(/[%_]/g, "\\$&");
  const like = `${escaped}%`;
  const contains = `%${escaped}%`;
  // Surface task_key matches first so typing `T-42` still resolves a
  // task referenced by its key. Synthetic team-root tasks are hidden.
  return db.prepare(`
    SELECT id, task_key, title, stage, project_id
    FROM tasks
    WHERE is_team_root = 0
      AND (
        task_key LIKE ? ESCAPE '\\'
        OR title LIKE ? ESCAPE '\\'
      )
    ORDER BY
      CASE WHEN task_key = ? THEN 0
           WHEN task_key LIKE ? ESCAPE '\\' THEN 1
           WHEN title LIKE ? ESCAPE '\\' THEN 2
           ELSE 3 END,
      updated_at DESC
    LIMIT ?
  `).all(contains, contains, q, like, like, limit);
}

export function getTaskKeyRow(db, id) {
  return db.prepare("SELECT task_key FROM tasks WHERE id = ?").get(id);
}

export function getTaskByClientRequestId(db, requestId) {
  return db.prepare("SELECT * FROM tasks WHERE client_request_id = ?").get(requestId);
}

// Filter clauses + bound params come from the route. Helper owns the column
// projection and ordering. Synthetic team-root tasks are hidden by default;
// callers that need them must explicitly opt in via includeTeamRoots: true.
export function listFilteredTasks(db, { filters, params, includeTeamRoots = false }) {
  const allFilters = [...(filters || [])];
  if (!includeTeamRoots) allFilters.push("is_team_root = 0");
  const where = allFilters.length ? ` WHERE ${allFilters.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM tasks${where} ORDER BY updated_at DESC`).all(...params);
}

const RUNTIME_TASK_LIST_COLUMNS = [
  "id",
  "task_key",
  "project_id",
  "team_id",
  "is_team_root",
  "goal_status",
  "goal_status_reason",
  "goal_contract_json",
  "last_lead_at",
  "root_task_id",
  "parent_task_id",
  "delegated_by_run_id",
  "delegated_to_agent",
  "owner_agent",
  "planner_agent",
  "client_request_id",
  "title",
  "stage",
  "stage_reason",
  "run_policy",
  "join_policy",
  "subtask_order",
  "required",
  "pending_actions_json",
  "pending_questions_json",
  "blocking_issues_json",
  "plan_updated_at",
  "plan_updated_by",
  "plan_source_run_id",
  "reviewer_agent",
  "parent_review_policy",
  "tags",
  "error_text",
  "failure_count",
  "rejection_streak",
  "lifetime_failure_count",
  "lifetime_rejection_count",
  "lifetime_recovery_continuation_count",
  "last_failure_kind",
  "created_at",
  "updated_at",
  "completed_at",
];

export function listRuntimeTaskRows(db, { filters, params, includeTeamRoots = false }) {
  const allFilters = [...(filters || [])];
  if (!includeTeamRoots) allFilters.push("is_team_root = 0");
  const where = allFilters.length ? ` WHERE ${allFilters.join(" AND ")}` : "";
  return db.prepare(`
    SELECT ${RUNTIME_TASK_LIST_COLUMNS.join(", ")}
    FROM tasks
    ${where}
    ORDER BY updated_at DESC
  `).all(...params);
}

export function listTaskSummaryRows(db, { filters, params, includeTeamRoots = false }) {
  const allFilters = [...(filters || [])];
  if (!includeTeamRoots) allFilters.push("is_team_root = 0");
  const where = allFilters.length ? ` WHERE ${allFilters.join(" AND ")}` : "";
  return db.prepare(`
    SELECT ${RUNTIME_TASK_LIST_COLUMNS.join(", ")}
    FROM tasks
    ${where}
    ORDER BY updated_at DESC
  `).all(...params);
}

export function listTasksByIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...ids);
}

export function listTaskSummaryRowsByIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`
    SELECT id, task_key, title, stage, updated_at, owner_agent,
           planner_agent, reviewer_agent, run_policy, project_id
    FROM tasks
    WHERE id IN (${placeholders})
  `).all(...ids);
}

export function getMaxSubtaskOrder(db, parentTaskId) {
  return (
    db
      .prepare("SELECT COALESCE(MAX(subtask_order), -1) AS max_order FROM tasks WHERE parent_task_id = ?")
      .get(parentTaskId)?.max_order ?? -1
  );
}

// Recursive UPDATE: walk task_edges (subtask only) and re-set project_id on
// every descendant whose project_id is NULL or matches the previous one.
export function cascadeProjectToDescendants(db, { taskId, previousProjectId, nextProjectId, updatedAt }) {
  const result = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT child_task_id
      FROM task_edges
      WHERE parent_task_id = ? AND edge_type = 'subtask'
      UNION
      SELECT e.child_task_id
      FROM task_edges e
      JOIN descendants d ON e.parent_task_id = d.id
      WHERE e.edge_type = 'subtask'
    )
    UPDATE tasks
    SET project_id = ?, updated_at = ?
    WHERE id IN (SELECT id FROM descendants)
      AND (project_id IS NULL OR project_id IS ?)
  `).run(taskId, nextProjectId, updatedAt, previousProjectId);
  return Number(result?.changes || 0);
}

// Dynamic-field UPDATE on tasks. Caller shapes fields/values; the row id
// must be last in values (UPDATE ... WHERE id = ?).
export function updateTaskFields(db, fields, values) {
  if (!fields.length) return;
  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteTaskByIdRow(db, taskId) {
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
}

export function insertTask(db, {
  id,
  taskKey,
  projectId,
  rootTaskId,
  clientRequestId,
  title,
  instructions,
  stage,
  ownerAgent,
  plannerAgent,
  reviewerAgent,
  runPolicy,
  tagsJson,
  teamId = null,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO tasks
      (id, task_key, project_id, team_id, root_task_id, client_request_id, title, instructions, stage, owner_agent,
       planner_agent, reviewer_agent, run_policy, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, taskKey, projectId, teamId, rootTaskId, clientRequestId, title, instructions, stage,
    ownerAgent, plannerAgent, reviewerAgent, runPolicy, tagsJson, createdAt, updatedAt,
  );
}

// Manual subtask creation — fixed stage='plan' and join_policy='all_required'
// per the manual-subtask path; agents create children through other helpers.
export function insertManualSubtask(db, {
  id,
  taskKey,
  rootTaskId,
  parentTaskId,
  ownerAgent,
  plannerAgent,
  reviewerAgent,
  projectId,
  title,
  instructions,
  runPolicy,
  subtaskOrder,
  required,
  tagsJson,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO tasks
      (id, task_key, root_task_id, parent_task_id, owner_agent, planner_agent, reviewer_agent,
       project_id, title, instructions, stage, run_policy, join_policy, subtask_order, required,
       tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plan', ?, 'all_required', ?, ?, ?, ?, ?)
  `).run(
    id, taskKey, rootTaskId, parentTaskId, ownerAgent, plannerAgent, reviewerAgent,
    projectId, title, instructions, runPolicy, subtaskOrder, required ? 1 : 0, tagsJson,
    createdAt, updatedAt,
  );
}

// Switch a parent task into the awaiting_children stage when a manual
// required subtask is created. Clears stage_reason / error_text / actions /
// blocking issues so the UI shows a clean waiting state.
export function markParentAwaitingChildren(db, parentTaskId, updatedAt) {
  db.prepare(`
    UPDATE tasks
    SET stage = 'awaiting_children',
        stage_reason = 'waiting for manual subtasks',
        error_text = NULL,
        completed_at = NULL,
        pending_actions_json = '[]',
        pending_questions_json = '[]',
        blocking_issues_json = '[]',
        updated_at = ?
    WHERE id = ?
  `).run(updatedAt, parentTaskId);
}

export function touchTaskUpdatedAt(db, taskId, updatedAt) {
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(updatedAt, taskId);
}

// R6: persist the resolved parent_review_policy on the parent task. Called
// by the watcher after a successful delegation round so subsequent
// execute-advance transitions can short-circuit the parent.review pass.
export function setTaskParentReviewPolicy(db, taskId, policy, updatedAt) {
  db.prepare(
    "UPDATE tasks SET parent_review_policy = ?, updated_at = ? WHERE id = ?",
  ).run(policy, updatedAt, taskId);
}

// R4: lifetime counters that survive `reset_failure_count`. Each helper is a
// monotonic +1 — callers fire on the same events that adjust the streak
// counters today.
export function incrementLifetimeFailureCount(db, taskId, updatedAt) {
  db.prepare(`
    UPDATE tasks
    SET lifetime_failure_count = lifetime_failure_count + 1, updated_at = ?
    WHERE id = ?
  `).run(updatedAt, taskId);
}

export function incrementLifetimeRejectionCount(db, taskId, updatedAt) {
  db.prepare(`
    UPDATE tasks
    SET lifetime_rejection_count = lifetime_rejection_count + 1, updated_at = ?
    WHERE id = ?
  `).run(updatedAt, taskId);
}

export function incrementLifetimeRecoveryContinuationCount(db, taskId, updatedAt) {
  db.prepare(`
    UPDATE tasks
    SET lifetime_recovery_continuation_count = lifetime_recovery_continuation_count + 1, updated_at = ?
    WHERE id = ?
  `).run(updatedAt, taskId);
}

// Lightweight read for the API/UI: returns the three lifetime counters and
// the most recent failure_kind so the task detail can render a "needed N
// retries" badge without reaching into task_runs.
export function getTaskHealth(db, taskId) {
  return db.prepare(`
    SELECT lifetime_failure_count, lifetime_rejection_count,
           lifetime_recovery_continuation_count, last_failure_kind
    FROM tasks
    WHERE id = ?
  `).get(taskId);
}

// Stale-run reconcile path: a worker is gone but `tasks.stage` may still be
// running. Don't clobber 'done'; otherwise force back to retryStage.
export function applyStaleRunReconcileToTask(db, { taskId, retryStage, errorTextFallback, updatedAt }) {
  db.prepare(`
    UPDATE tasks SET stage = CASE WHEN stage = 'done' THEN stage ELSE ? END,
                     error_text = COALESCE(error_text, ?),
                     stage_reason = COALESCE(stage_reason, 'abandoned'),
                     updated_at = ?
    WHERE id = ?
  `).run(retryStage, errorTextFallback, updatedAt, taskId);
}

export function listProjectTasksWithRunSnapshots(db, projectId) {
  return db.prepare(`
    SELECT
      t.id, t.task_key, t.title, t.stage, t.stage_reason, t.run_policy,
      t.owner_agent, t.planner_agent, t.reviewer_agent, t.root_task_id, t.parent_task_id, t.team_id,
      t.pending_actions_json, t.pending_questions_json, t.blocking_issues_json, t.failure_count,
      t.rejection_streak, t.last_failure_kind, t.error_text, t.updated_at,
      (
        SELECT COUNT(*)
        FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id AND COALESCE(dep.stage, 'plan') <> 'done'
      ) AS unresolved_dependency_count,
      rr.id AS running_run_id,
      rr.status AS running_run_status,
      rr.process_status AS running_run_process_status,
      rr.started_at AS running_run_started_at,
      lr.id AS last_run_id,
      lr.status AS last_run_status,
      lr.process_status AS last_run_process_status,
      lr.failure_kind AS last_run_failure_kind,
      lr.ended_at AS last_run_ended_at,
      lr.stage AS last_run_stage,
      lr.mode AS last_run_mode,
      lr.decision AS last_run_decision,
      lr.summary AS last_run_summary
    FROM tasks t
    LEFT JOIN task_runs rr ON rr.id = (
      SELECT r.id
      FROM task_runs r
      WHERE r.task_id = t.id AND r.status = 'running'
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT 1
    )
    LEFT JOIN task_runs lr ON lr.id = (
      SELECT r.id
      FROM task_runs r
      WHERE r.task_id = t.id AND r.status <> 'running'
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT 1
    )
    WHERE t.project_id = ? AND t.is_team_root = 0
    ORDER BY t.updated_at DESC
  `).all(projectId);
}
