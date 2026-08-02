const OPERATION_KINDS = new Set([
  "probe",
  "authenticate",
  "logout",
  "list_sessions",
  "delete_session",
]);

const OPERATION_STATES = new Set([
  "queued",
  "running",
  "waiting_for_interaction",
  "succeeded",
  "failed",
  "cancelled",
]);

export function insertAcpOperation(db, operation) {
  if (!OPERATION_KINDS.has(operation.kind)) throw new Error(`invalid ACP operation kind: ${operation.kind}`);
  db.prepare(`
    INSERT INTO acp_operations (
      id, profile_id, kind, state, remote_session_id, request_json,
      result_json, error_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, ?, '{}', '{}', ?, ?)
  `).run(
    operation.id,
    operation.profileId,
    operation.kind,
    operation.remoteSessionId || null,
    operation.requestJson || "{}",
    operation.createdAt,
    operation.updatedAt,
  );
}

export function getAcpOperationById(db, id) {
  return db.prepare(`
    SELECT o.*, p.agent_name, p.driver
    FROM acp_operations o
    JOIN acp_profiles p ON p.id = o.profile_id
    WHERE o.id = ?
  `).get(id);
}

export function listAcpOperationsForProfile(db, profileId, limit = 50) {
  return db.prepare(`
    SELECT * FROM acp_operations
    WHERE profile_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(profileId, limit);
}

function transitionOperation(db, id, fromStates, state, fields = {}) {
  if (!OPERATION_STATES.has(state)) throw new Error(`invalid ACP operation state: ${state}`);
  const allowed = fromStates.filter((candidate) => OPERATION_STATES.has(candidate));
  if (!allowed.length) throw new Error("ACP operation transition requires a source state");
  const sets = ["state = ?", "updated_at = ?"];
  const values = [state, fields.updatedAt ?? Date.now()];
  for (const [key, column] of [
    ["resultJson", "result_json"],
    ["errorJson", "error_json"],
    ["startedAt", "started_at"],
    ["completedAt", "completed_at"],
  ]) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  values.push(id, ...allowed);
  return db.prepare(`
    UPDATE acp_operations
    SET ${sets.join(", ")}
    WHERE id = ? AND state IN (${allowed.map(() => "?").join(", ")})
  `).run(...values);
}

export function markAcpOperationRunning(db, id, {
  startedAt = Date.now(),
  updatedAt = startedAt,
} = {}) {
  const queued = transitionOperation(db, id, ["queued"], "running", {
    startedAt,
    updatedAt,
  });
  if (queued.changes === 1) return queued;
  return transitionOperation(db, id, ["waiting_for_interaction"], "running", {
    updatedAt,
  });
}

export function markAcpOperationWaiting(db, id, { updatedAt = Date.now() } = {}) {
  return transitionOperation(db, id, ["running"], "waiting_for_interaction", { updatedAt });
}

export function completeAcpOperation(db, id, {
  resultJson = "{}",
  completedAt = Date.now(),
} = {}) {
  return transitionOperation(db, id, ["running"], "succeeded", {
    resultJson,
    errorJson: "{}",
    updatedAt: completedAt,
    completedAt,
  });
}

export function failAcpOperation(db, id, {
  errorJson = "{}",
  completedAt = Date.now(),
} = {}) {
  return transitionOperation(db, id, ["queued", "running", "waiting_for_interaction"], "failed", {
    errorJson,
    updatedAt: completedAt,
    completedAt,
  });
}

export function cancelAcpOperation(db, id, {
  errorJson = "{}",
  completedAt = Date.now(),
} = {}) {
  return transitionOperation(db, id, ["queued", "running", "waiting_for_interaction"], "cancelled", {
    errorJson,
    updatedAt: completedAt,
    completedAt,
  });
}

export function countActiveAcpOperationsForProfile(db, profileId) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM acp_operations
    WHERE profile_id = ?
      AND state IN ('queued', 'running', 'waiting_for_interaction')
  `).get(profileId)?.count) || 0;
}
