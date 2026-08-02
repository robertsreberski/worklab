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

export function listAgentsByNamePrefix(db, query, limit) {
  const q = String(query || "").trim();
  if (!q) return [];
  const like = `${q.replace(/[%_]/g, "\\$&")}%`;
  const contains = `%${q.replace(/[%_]/g, "\\$&")}%`;
  return db.prepare(`
    SELECT name, display_name, description, enabled
    FROM agents
    WHERE name LIKE ? ESCAPE '\\'
       OR display_name LIKE ? ESCAPE '\\'
    ORDER BY
      CASE WHEN name = ? THEN 0
           WHEN name LIKE ? ESCAPE '\\' THEN 1
           WHEN display_name LIKE ? ESCAPE '\\' THEN 2
           ELSE 3 END,
      enabled DESC,
      name
    LIMIT ?
  `).all(contains, contains, q, like, like, limit);
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
      a.name,
      a.display_name,
      a.description,
      a.sdk,
      a.model,
      a.effort,
      a.context_window,
      a.fast_mode,
      a.instructions,
      a.skills_allowlist,
      a.skills_allowlist_mode,
      a.mcp_allowlist,
      a.mcp_allowlist_mode,
      a.builtin_allowlist,
      a.builtin_allowlist_mode,
      a.allow_self_review,
      a.browser_tools_review_only,
      a.subagent_mode,
      a.execution_mode,
      a.enabled,
      CASE WHEN p.id IS NULL THEN 'local' ELSE 'external' END AS kind,
      p.id AS acp_profile_id,
      p.driver AS driver,
      a.created_at,
      a.updated_at,
      last_runs.last_run_at,
      COALESCE(recent_runs.run_count_30d, 0) AS run_count_30d,
      recent_runs.avg_run_duration_ms
    FROM agents a
    LEFT JOIN acp_profiles p ON p.agent_name = a.name
    LEFT JOIN (
      SELECT agent_name, MAX(started_at) AS last_run_at
      FROM task_runs
      GROUP BY agent_name
    ) last_runs ON last_runs.agent_name = a.name
    LEFT JOIN (
      SELECT
        r.agent_name,
        COUNT(*) AS run_count_30d,
        AVG(l.duration_ms) AS avg_run_duration_ms
      FROM task_runs r
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      WHERE r.started_at >= ?
      GROUP BY r.agent_name
    ) recent_runs ON recent_runs.agent_name = a.name
    ORDER BY a.name
  `).all(since);
}

export function listAgentSummariesWithRunStats(db, since) {
  return db.prepare(`
    SELECT
      a.name,
      a.display_name,
      a.description,
      a.sdk,
      a.model,
      a.effort,
      a.context_window,
      a.fast_mode,
      a.subagent_mode,
      a.execution_mode,
      a.enabled,
      CASE WHEN p.id IS NULL THEN 'local' ELSE 'external' END AS kind,
      p.id AS acp_profile_id,
      p.driver AS driver,
      a.created_at,
      a.updated_at,
      last_runs.last_run_at,
      COALESCE(recent_runs.run_count_30d, 0) AS run_count_30d,
      recent_runs.avg_run_duration_ms
    FROM agents a
    LEFT JOIN acp_profiles p ON p.agent_name = a.name
    LEFT JOIN (
      SELECT agent_name, MAX(started_at) AS last_run_at
      FROM task_runs
      GROUP BY agent_name
    ) last_runs ON last_runs.agent_name = a.name
    LEFT JOIN (
      SELECT
        r.agent_name,
        COUNT(*) AS run_count_30d,
        AVG(l.duration_ms) AS avg_run_duration_ms
      FROM task_runs r
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      WHERE r.started_at >= ?
      GROUP BY r.agent_name
    ) recent_runs ON recent_runs.agent_name = a.name
    ORDER BY a.name
  `).all(since);
}

export function insertAgent(db, {
  name,
  displayName,
  description,
  sdk,
  model,
  effort,
  contextWindow,
  fastMode,
  instructions,
  skillsAllowlistJson,
  skillsAllowlistMode,
  mcpAllowlistJson,
  mcpAllowlistMode,
  builtinAllowlistJson,
  builtinAllowlistMode,
  allowSelfReview,
  browserToolsReviewOnly,
  subagentMode,
  executionMode,
  enabled,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO agents
      (name, display_name, description, sdk, model, effort, context_window, fast_mode, instructions,
       skills_allowlist, skills_allowlist_mode, mcp_allowlist, mcp_allowlist_mode,
       builtin_allowlist, builtin_allowlist_mode, allow_self_review,
       browser_tools_review_only, subagent_mode, execution_mode, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, displayName, description, sdk, model, effort, contextWindow || "default", fastMode === false ? 0 : 1, instructions,
    skillsAllowlistJson, skillsAllowlistMode,
    mcpAllowlistJson, mcpAllowlistMode,
    builtinAllowlistJson, builtinAllowlistMode,
    allowSelfReview, browserToolsReviewOnly,
    subagentMode || "advisory",
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
