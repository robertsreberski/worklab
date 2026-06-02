// Mention-search queries used by the API typeahead route.

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function likeWhere(columns, q) {
  if (!q) return { clause: "1 = 1", params: [] };
  const pattern = `%${escapeLike(q)}%`;
  return {
    clause: `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    params: columns.map(() => pattern),
  };
}

export function searchMentionGoals(db, q, limit) {
  const where = likeWhere([
    "g.id",
    "g.root_task_id",
    "g.status",
    "g.status_reason",
    "g.contract_json",
    "p.name",
    "p.slug",
    "t.name",
    "t.slug",
  ], q);
  return db.prepare(`
    SELECT
      g.id,
      g.status,
      g.status_reason,
      g.contract_json,
      g.project_id,
      g.team_id,
      g.root_task_id,
      g.last_lead_at,
      g.created_at,
      g.updated_at,
      p.name AS project_name,
      p.slug AS project_slug,
      t.name AS team_name,
      t.slug AS team_slug
    FROM goals g
    LEFT JOIN projects p ON p.id = g.project_id
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE ${where.clause}
    ORDER BY COALESCE(g.last_lead_at, g.updated_at) DESC
    LIMIT ?
  `).all(...where.params, limit);
}

export function searchMentionRuns(db, q, limit) {
  const where = likeWhere([
    "r.id",
    "r.task_id",
    "r.summary",
    "r.details",
    "r.error_text",
    "r.status",
    "r.process_status",
    "t.task_key",
    "t.title",
  ], q);
  return db.prepare(`
    SELECT
      r.id,
      r.task_id,
      r.mode,
      r.stage,
      r.status,
      r.process_status,
      r.summary,
      r.details,
      r.error_text,
      r.started_at,
      r.ended_at,
      t.task_key,
      t.title AS task_title
    FROM task_runs r
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE ${where.clause}
    ORDER BY r.started_at DESC, r.rowid DESC
    LIMIT ?
  `).all(...where.params, limit);
}

export function searchMentionAgents(db, q, limit) {
  const where = likeWhere(["name", "display_name", "description", "instructions"], q);
  return db.prepare(`
    SELECT name, display_name, description, instructions, enabled, created_at, updated_at
    FROM agents
    WHERE ${where.clause}
    ORDER BY updated_at DESC, name
    LIMIT ?
  `).all(...where.params, limit);
}

export function searchMentionTasks(db, q, limit) {
  const where = likeWhere(["id", "task_key", "title", "instructions", "plan_body"], q);
  return db.prepare(`
    SELECT id, task_key, title, instructions, plan_body, stage, project_id, created_at, updated_at
    FROM tasks
    WHERE is_team_root = 0
      AND ${where.clause}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...where.params, limit);
}

export function searchMentionProjects(db, q, limit) {
  const where = likeWhere(["id", "slug", "name", "description", "context_markdown"], q);
  return db.prepare(`
    SELECT id, slug, name, description, context_markdown, archived, created_at, updated_at
    FROM projects
    WHERE archived = 0
      AND ${where.clause}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...where.params, limit);
}

export function searchMentionTeams(db, q, limit) {
  const where = likeWhere(["id", "slug", "name", "description", "goal"], q);
  return db.prepare(`
    SELECT id, slug, name, description, goal, status, created_at, updated_at
    FROM teams
    WHERE status <> 'archived'
      AND ${where.clause}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...where.params, limit);
}
