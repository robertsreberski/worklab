// projects-table queries.

export function getProjectById(db, id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function resolveProjectByIdOrSlug(db, value) {
  return db.prepare("SELECT * FROM projects WHERE id = ? OR slug = ?").get(value, value);
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
      COALESCE(COUNT(t.id), 0) AS task_count,
      COALESCE(SUM(CASE WHEN t.stage <> 'done' THEN 1 ELSE 0 END), 0) AS active_task_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id AND t.is_team_root = 0
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
  teamId = null,
  archived,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, worktree_mode, tags_json,
       team_id, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, slug, name, description, context, workdir, worktreeMode, tagsJson,
    teamId, archived, createdAt, updatedAt,
  );
}

// Dynamic-field UPDATE. The route shapes the SET clauses + bound values from
// the request patch and is responsible for putting the row id last in values.
export function updateProjectFields(db, fields, values) {
  if (!fields.length) return;
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function listProjectsForKbTagMatching(db) {
  return db.prepare("SELECT id, slug, name, tags_json, archived FROM projects").all();
}

export function listProjectsByIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM projects WHERE id IN (${placeholders})`).all(...ids);
}
