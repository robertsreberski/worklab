const SAFE_DISPOSITIONS = new Set([
  "accept",
  "decline",
  "cancel",
  "selected",
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

function normalizedDisposition(value) {
  const disposition = String(value || "").trim();
  if (!SAFE_DISPOSITIONS.has(disposition)) {
    throw new Error(`invalid ACP interaction disposition: ${disposition || "<empty>"}`);
  }
  return disposition;
}

export function insertAcpInteractionRequest(db, interaction) {
  db.prepare(`
    INSERT INTO acp_interactions (
      id, profile_id, task_run_id, operation_id, protocol_request_id,
      kind, request_schema_json, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    interaction.id,
    interaction.profileId,
    interaction.taskRunId || null,
    interaction.operationId || null,
    interaction.protocolRequestId,
    interaction.kind,
    interaction.requestSchemaJson || "{}",
    interaction.createdAt,
    interaction.updatedAt,
  );
}

export const insertAcpInteraction = insertAcpInteractionRequest;

export function getAcpInteractionById(db, id) {
  return db.prepare("SELECT * FROM acp_interactions WHERE id = ?").get(id);
}

export function getPendingAcpInteractionById(db, id) {
  return db.prepare("SELECT * FROM acp_interactions WHERE id = ? AND state = 'pending'").get(id);
}

export function listAcpInteractions(db, { state = null, profileId = null, limit = 200 } = {}) {
  const clauses = [];
  const values = [];
  if (state) {
    clauses.push("i.state = ?");
    values.push(state);
  }
  if (profileId) {
    clauses.push("i.profile_id = ?");
    values.push(profileId);
  }
  values.push(limit);
  return db.prepare(`
    SELECT i.*, p.agent_name
    FROM acp_interactions i
    JOIN acp_profiles p ON p.id = i.profile_id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY i.created_at ASC, i.rowid ASC
    LIMIT ?
  `).all(...values);
}

export function listAcpInteractionsForOperation(db, operationId) {
  return db.prepare(`
    SELECT * FROM acp_interactions
    WHERE operation_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(operationId);
}

export function listAcpInteractionsForRun(db, taskRunId) {
  return db.prepare(`
    SELECT * FROM acp_interactions
    WHERE task_run_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(taskRunId);
}

export function claimAcpInteractionResponse(db, id, {
  disposition,
  updatedAt = Date.now(),
} = {}) {
  const normalized = normalizedDisposition(disposition);
  const info = db.prepare(`
    UPDATE acp_interactions
    SET state = 'submitted', disposition = ?, updated_at = ?, resolved_at = NULL
    WHERE id = ? AND state = 'pending'
  `).run(normalized, updatedAt, id);
  return info.changes === 1 ? getAcpInteractionById(db, id) : null;
}

export function finalizeAcpInteractionResponse(db, id, {
  resolvedAt = Date.now(),
} = {}) {
  const info = db.prepare(`
    UPDATE acp_interactions
    SET updated_at = ?, resolved_at = ?
    WHERE id = ? AND state = 'submitted' AND resolved_at IS NULL
  `).run(resolvedAt, resolvedAt, id);
  return info.changes === 1 ? getAcpInteractionById(db, id) : null;
}

export function releaseAcpInteractionResponse(db, id, {
  updatedAt = Date.now(),
} = {}) {
  const info = db.prepare(`
    UPDATE acp_interactions
    SET state = 'pending', disposition = NULL, updated_at = ?, resolved_at = NULL
    WHERE id = ? AND state = 'submitted' AND resolved_at IS NULL
  `).run(updatedAt, id);
  return info.changes === 1 ? getAcpInteractionById(db, id) : null;
}

export function submitAcpInteraction(db, id, options = {}) {
  const claimed = claimAcpInteractionResponse(db, id, options);
  if (!claimed) return null;
  return finalizeAcpInteractionResponse(db, id, options);
}

export function cancelAcpInteraction(db, id, {
  disposition = "cancel",
  resolvedAt = Date.now(),
} = {}) {
  const normalized = normalizedDisposition(disposition);
  const info = db.prepare(`
    UPDATE acp_interactions
    SET state = 'cancelled', disposition = ?, updated_at = ?, resolved_at = ?
    WHERE id = ?
      AND (state = 'pending' OR (state = 'submitted' AND resolved_at IS NULL))
  `).run(normalized, resolvedAt, resolvedAt, id);
  return info.changes === 1 ? getAcpInteractionById(db, id) : null;
}

export function expirePendingAcpInteractionsForOperation(db, operationId, {
  disposition = "operation_ended",
  resolvedAt = Date.now(),
} = {}) {
  return db.prepare(`
    UPDATE acp_interactions
    SET state = 'expired', disposition = ?, updated_at = ?, resolved_at = ?
    WHERE operation_id = ? AND state = 'pending'
  `).run(disposition, resolvedAt, resolvedAt, operationId);
}

export function expirePendingAcpInteractionsForRun(db, taskRunId, {
  disposition = "run_ended",
  resolvedAt = Date.now(),
} = {}) {
  return db.prepare(`
    UPDATE acp_interactions
    SET state = 'expired', disposition = ?, updated_at = ?, resolved_at = ?
    WHERE task_run_id = ? AND state = 'pending'
  `).run(disposition, resolvedAt, resolvedAt, taskRunId);
}
