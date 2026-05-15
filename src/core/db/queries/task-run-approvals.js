// task_run_approvals (v46) — audit trail for HITL tool approvals.
//
// One row per `onToolApprovalRequest` invocation from the agent runtime.
// The coordinator inserts a row with status="pending" when the worker
// emits an `approval_requested` event; the API updates the row when the
// user decides; the coordinator's timeout watchdog flips abandoned rows
// to status="expired" if the worker exits without a decision.

import { randomUUID } from "node:crypto";

export function insertApprovalRequest(db, {
  taskRunId,
  requestId,
  toolName,
  toolUseId = null,
  argumentsSummary = "",
  riskTier = "medium",
  model = null,
}) {
  const id = randomUUID();
  const requestedAt = Date.now();
  db.prepare(
    `INSERT INTO task_run_approvals
       (id, task_run_id, request_id, tool_name, tool_use_id, arguments_summary,
        risk_tier, model, status, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(task_run_id, request_id) DO NOTHING`,
  ).run(id, taskRunId, requestId, toolName, toolUseId, argumentsSummary, riskTier, model, requestedAt);
  return db
    .prepare("SELECT * FROM task_run_approvals WHERE task_run_id = ? AND request_id = ?")
    .get(taskRunId, requestId);
}

export function recordApprovalDecision(db, taskRunId, requestId, {
  decision,
  reason = null,
  decidedBy = null,
}) {
  if (!["approve", "deny", "always"].includes(decision)) {
    throw new Error(`invalid approval decision: ${decision}`);
  }
  const status = decision === "deny" ? "denied" : decision === "always" ? "always" : "approved";
  const decidedAt = Date.now();
  const info = db.prepare(
    `UPDATE task_run_approvals
       SET status = ?, decision = ?, reason = ?, decided_by = ?, decided_at = ?
     WHERE task_run_id = ? AND request_id = ? AND status = 'pending'`,
  ).run(status, decision, reason, decidedBy, decidedAt, taskRunId, requestId);
  if (info.changes === 0) return null;
  return db
    .prepare("SELECT * FROM task_run_approvals WHERE task_run_id = ? AND request_id = ?")
    .get(taskRunId, requestId);
}

export function expireApprovalRequest(db, taskRunId, requestId, { reason = "timeout" } = {}) {
  db.prepare(
    `UPDATE task_run_approvals
       SET status = 'expired', decision = NULL, reason = ?, decided_at = ?
     WHERE task_run_id = ? AND request_id = ? AND status = 'pending'`,
  ).run(reason, Date.now(), taskRunId, requestId);
}

export function expirePendingApprovalsForRun(db, taskRunId, { reason = "run_terminated" } = {}) {
  db.prepare(
    `UPDATE task_run_approvals
       SET status = 'expired', reason = ?, decided_at = ?
     WHERE task_run_id = ? AND status = 'pending'`,
  ).run(reason, Date.now(), taskRunId);
}

export function listApprovalsForRun(db, taskRunId) {
  return db
    .prepare("SELECT * FROM task_run_approvals WHERE task_run_id = ? ORDER BY requested_at ASC")
    .all(taskRunId);
}

export function getPendingApproval(db, taskRunId, requestId) {
  return db
    .prepare(
      "SELECT * FROM task_run_approvals WHERE task_run_id = ? AND request_id = ? AND status = 'pending'",
    )
    .get(taskRunId, requestId);
}

export function countPendingApprovalsForRun(db, taskRunId) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM task_run_approvals WHERE task_run_id = ? AND status = 'pending'")
    .get(taskRunId);
  return Number(row?.n) || 0;
}

export function countPendingApprovalsForTask(db, taskId) {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n FROM task_run_approvals a
      JOIN task_runs r ON r.id = a.task_run_id
      WHERE r.task_id = ? AND a.status = 'pending'
    `)
    .get(taskId);
  return Number(row?.n) || 0;
}
