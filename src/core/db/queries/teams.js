// teams + team_members queries. The watcher and lead-cycle scheduler hit these
// frequently; routes/MCP use the same surface so all team CRUD lives in one
// place. See src/core/teams.js for the higher-level domain helpers.

export function getTeamById(db, id) {
  return db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
}

export function resolveTeamByIdOrSlug(db, value) {
  return db.prepare("SELECT * FROM teams WHERE id = ? OR slug = ?").get(value, value);
}

export function getTeamIdBySlug(db, slug) {
  const row = db.prepare("SELECT id FROM teams WHERE slug = ?").get(slug);
  return row?.id || null;
}

export function listTeams(db, { filters = [], params = [], limit = 200 } = {}) {
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return db.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
           (SELECT COUNT(*) FROM projects p WHERE p.team_id = t.id) AS project_count
    FROM teams t
    ${where}
    ORDER BY t.status ASC, t.updated_at DESC, t.name ASC
    LIMIT ?
  `).all(...params, limit);
}

export function insertTeam(db, {
  id,
  slug,
  name,
  description = "",
  goal = "",
  leadAgent = null,
  status = "active",
  scheduleEnabled = 0,
  scheduleIntervalMinutes = null,
  dailyBudgetUsd = null,
  perRunBudgetUsd = null,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO teams
      (id, slug, name, description, goal, lead_agent, status,
       schedule_enabled, schedule_interval_minutes,
       daily_budget_usd, per_run_budget_usd,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, slug, name, description, goal, leadAgent, status,
    scheduleEnabled ? 1 : 0, scheduleIntervalMinutes,
    dailyBudgetUsd, perRunBudgetUsd,
    createdAt, updatedAt,
  );
}

export function updateTeamFields(db, fields, values) {
  if (!fields.length) return;
  db.prepare(`UPDATE teams SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function archiveTeam(db, id, updatedAt) {
  db.prepare("UPDATE teams SET status = 'archived', updated_at = ? WHERE id = ?").run(updatedAt, id);
}

export function deleteTeam(db, id) {
  return db.prepare("DELETE FROM teams WHERE id = ?").run(id);
}

export function setTeamLastLeadCycleAt(db, id, ts) {
  db.prepare("UPDATE teams SET last_lead_cycle_at = ? WHERE id = ?").run(ts, id);
}

// ---- members ----

export function listTeamMembers(db, teamId) {
  return db.prepare(`
    SELECT m.team_id, m.agent_name, m.role_description, m.created_at,
           a.display_name, a.enabled
    FROM team_members m
    LEFT JOIN agents a ON a.name = m.agent_name
    WHERE m.team_id = ?
    ORDER BY a.display_name COLLATE NOCASE ASC
  `).all(teamId);
}

export function listTeamsForAgent(db, agentName) {
  return db.prepare(`
    SELECT t.id, t.slug, t.name, m.role_description
    FROM team_members m
    JOIN teams t ON t.id = m.team_id
    WHERE m.agent_name = ?
    ORDER BY t.name COLLATE NOCASE ASC
  `).all(agentName);
}

export function clearTeamMembers(db, teamId) {
  db.prepare("DELETE FROM team_members WHERE team_id = ?").run(teamId);
}

export function insertTeamMember(db, { teamId, agentName, roleDescription = "", createdAt }) {
  db.prepare(`
    INSERT INTO team_members (team_id, agent_name, role_description, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id, agent_name) DO UPDATE SET role_description = excluded.role_description
  `).run(teamId, agentName, roleDescription, createdAt);
}

export function getTeamRosterAgentNames(db, teamId) {
  if (!teamId) return [];
  const lead = db.prepare("SELECT lead_agent FROM teams WHERE id = ?").get(teamId);
  const members = db.prepare("SELECT agent_name FROM team_members WHERE team_id = ?").all(teamId);
  const set = new Set();
  if (lead?.lead_agent) set.add(lead.lead_agent);
  for (const row of members) if (row.agent_name) set.add(row.agent_name);
  return Array.from(set);
}

// ---- project / task team assignment ----

export function getProjectTeamId(db, projectId) {
  if (!projectId) return null;
  const row = db.prepare("SELECT team_id FROM projects WHERE id = ?").get(projectId);
  return row?.team_id || null;
}

export function listProjectsForTeam(db, teamId) {
  return db.prepare(`
    SELECT id, slug, name, archived
    FROM projects
    WHERE team_id = ?
    ORDER BY archived ASC, name COLLATE NOCASE ASC
  `).all(teamId);
}

// ---- synthetic root tasks ----

export function getTeamRootTask(db, { teamId, projectId }) {
  if (!teamId || !projectId) return null;
  return db.prepare(`
    SELECT * FROM tasks
    WHERE is_team_root = 1 AND team_id = ? AND project_id = ?
    LIMIT 1
  `).get(teamId, projectId);
}

export function listTeamRootTasks(db, teamId) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE is_team_root = 1 AND team_id = ?
    ORDER BY updated_at DESC
  `).all(teamId);
}

export function setTaskGoalStatus(db, taskId, { goalStatus, goalStatusReason, lastLeadAt, updatedAt }) {
  db.prepare(`
    UPDATE tasks
    SET goal_status = ?, goal_status_reason = ?, last_lead_at = ?, updated_at = ?
    WHERE id = ?
  `).run(goalStatus, goalStatusReason, lastLeadAt, updatedAt, taskId);
}

// ---- lead-cycle runs ----

export function hasInFlightLeadCycle(db, { teamId, projectId } = {}) {
  if (!teamId) return false;
  const row = db.prepare(`
    SELECT r.id
    FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.kind = 'lead_cycle'
      AND r.process_status IN ('queued', 'running')
      AND t.is_team_root = 1
      AND t.team_id = ?
      ${projectId ? "AND t.project_id = ?" : ""}
    LIMIT 1
  `).get(...(projectId ? [teamId, projectId] : [teamId]));
  return Boolean(row);
}

export function listRecentLeadCycles(db, teamId, limit = 50) {
  return db.prepare(`
    SELECT r.id, r.task_id, r.team_id, r.project_id, r.kind, r.mode,
           r.process_status, r.status, r.failure_kind,
           r.started_at, r.ended_at, r.cost_usd, r.summary,
           t.title AS task_title
    FROM task_runs r
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.kind = 'lead_cycle' AND r.team_id = ?
    ORDER BY r.started_at DESC, r.rowid DESC
    LIMIT ?
  `).all(teamId, limit);
}

export function getLastLeadCycleAt(db, { teamId, projectId } = {}) {
  if (!teamId) return null;
  const row = db.prepare(`
    SELECT MAX(r.started_at) AS ts
    FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.kind = 'lead_cycle'
      AND t.is_team_root = 1
      AND t.team_id = ?
      ${projectId ? "AND t.project_id = ?" : ""}
  `).get(...(projectId ? [teamId, projectId] : [teamId]));
  return row?.ts ?? null;
}
