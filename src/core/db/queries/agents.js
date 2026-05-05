// agents-table queries.

export function getAgentByName(db, name) {
  return db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
}

export function getEnabledAgentByName(db, name) {
  return db.prepare("SELECT * FROM agents WHERE name = ? AND enabled = 1").get(name);
}

export function agentExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM agents WHERE name = ?").get(name));
}

export function enabledAgentExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM agents WHERE name = ? AND enabled = 1").get(name));
}

export function listEnabledAgentNames(db) {
  return db.prepare("SELECT name FROM agents WHERE enabled = 1 ORDER BY name").all().map((row) => row.name);
}

export function getAgentSelfReviewFlag(db, name) {
  return db.prepare("SELECT allow_self_review FROM agents WHERE name = ?").get(name);
}

export function listAgentSkillsAllowlists(db) {
  return db.prepare("SELECT skills_allowlist, skills_allowlist_mode FROM agents").all();
}

export function listAgentSkillsAllowlistsWithNames(db) {
  return db
    .prepare("SELECT name, display_name, skills_allowlist, skills_allowlist_mode FROM agents")
    .all();
}

export function listAgentModelRefs(db) {
  return db.prepare("SELECT name, display_name, model, enabled FROM agents").all();
}

export function listAgentInstructionsForKbUsage(db) {
  return db.prepare("SELECT name, display_name, instructions FROM agents").all();
}

// Agent list with last-run timestamp + 30-day run count + average duration.
// `since` is a unix-ms cutoff.
export function listAgentsWithRunStats(db, since) {
  return db.prepare(`
    SELECT
      a.*,
      MAX(r.started_at) AS last_run_at,
      COUNT(CASE WHEN r.started_at >= ? THEN 1 END) AS run_count_30d,
      AVG(CASE WHEN r.started_at >= ? THEN l.duration_ms END) AS avg_run_duration_ms
    FROM agents a
    LEFT JOIN task_runs r ON r.agent_name = a.name
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    GROUP BY a.name
    ORDER BY a.name
  `).all(since, since);
}

export function insertAgent(db, {
  name,
  displayName,
  description,
  sdk,
  model,
  effort,
  instructions,
  skillsAllowlistJson,
  skillsAllowlistMode,
  mcpAllowlistJson,
  mcpAllowlistMode,
  builtinAllowlistJson,
  builtinAllowlistMode,
  allowSelfReview,
  browserToolsReviewOnly,
  executionMode,
  enabled,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO agents
      (name, display_name, description, sdk, model, effort, instructions,
       skills_allowlist, skills_allowlist_mode, mcp_allowlist, mcp_allowlist_mode,
       builtin_allowlist, builtin_allowlist_mode, allow_self_review,
       browser_tools_review_only, execution_mode, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, displayName, description, sdk, model, effort, instructions,
    skillsAllowlistJson, skillsAllowlistMode,
    mcpAllowlistJson, mcpAllowlistMode,
    builtinAllowlistJson, builtinAllowlistMode,
    allowSelfReview, browserToolsReviewOnly,
    executionMode || "sdk",
    enabled, createdAt, updatedAt,
  );
}

// Dynamic-field UPDATE. The route shapes fields/values; the row name lives
// last in values (UPDATE ... WHERE name = ?).
export function updateAgentFields(db, fields, values) {
  if (!fields.length) return;
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE name = ?`).run(...values);
}

export function deleteAgentByName(db, name) {
  return db.prepare("DELETE FROM agents WHERE name = ?").run(name);
}
