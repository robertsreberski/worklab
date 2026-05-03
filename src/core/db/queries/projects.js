// projects-table queries.

export function getProjectById(db, id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function resolveProjectByIdOrSlug(db, value) {
  return db.prepare("SELECT * FROM projects WHERE id = ? OR slug = ?").get(value, value);
}

export function getProjectIdBySlug(db, slug) {
  const row = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
  return row?.id || null;
}

export function archiveProject(db, id, updatedAt) {
  db.prepare("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?").run(updatedAt, id);
}

// Project list with per-row task counts. Filter clauses + bound params are
// shaped by the route from request input; helper owns the joins/aggregation.
export function listProjectsWithTaskCounts(db, { filters, params, limit }) {
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `
    SELECT
      p.*,
      COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.stage <> 'done' THEN 1 ELSE 0 END) AS active_task_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    ${where}
    GROUP BY p.id
    ORDER BY p.archived ASC, p.updated_at DESC, p.name ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit);
}

export function insertProject(db, {
  id,
  slug,
  name,
  description,
  context,
  workdir,
  worktreeMode = "off",
  tagsJson,
  allowedAgentsJson = "[]",
  delegationAllowUnlisted = 0,
  archived,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, worktree_mode, tags_json,
       allowed_agents_json, delegation_allow_unlisted, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, slug, name, description, context, workdir, worktreeMode, tagsJson,
    allowedAgentsJson, delegationAllowUnlisted ? 1 : 0,
    archived, createdAt, updatedAt,
  );
}

// Dynamic-field UPDATE. The route shapes the SET clauses + bound values from
// the request patch and is responsible for putting the row id last in values.
export function updateProjectFields(db, fields, values) {
  if (!fields.length) return;
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function listProjectsByIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM projects WHERE id IN (${placeholders})`).all(...ids);
}

// R9: per-project agent allowlist + delegation override flag. Returns the
// raw JSON string for the allowlist (caller parses) and a boolean for the
// override. `null` for either field is treated as the back-compat default.
export function getProjectAllowedAgents(db, projectId) {
  if (!projectId) return null;
  const row = db.prepare(
    "SELECT allowed_agents_json, delegation_allow_unlisted FROM projects WHERE id = ?",
  ).get(projectId);
  if (!row) return null;
  return {
    allowed_agents_json: row.allowed_agents_json || "[]",
    delegation_allow_unlisted: row.delegation_allow_unlisted ? 1 : 0,
  };
}

export function setProjectAllowedAgents(db, projectId, { allowedAgentsJson, delegationAllowUnlisted, updatedAt }) {
  const sets = [];
  const values = [];
  if (allowedAgentsJson !== undefined) {
    sets.push("allowed_agents_json = ?");
    values.push(allowedAgentsJson);
  }
  if (delegationAllowUnlisted !== undefined) {
    sets.push("delegation_allow_unlisted = ?");
    values.push(delegationAllowUnlisted ? 1 : 0);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  values.push(updatedAt ?? Date.now());
  values.push(projectId);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}
