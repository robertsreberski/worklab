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
