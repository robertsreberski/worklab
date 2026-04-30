import { mkdirSync } from "node:fs";
import { newProjectId } from "../core/ids.js";
import {
  normalizeProjectWorkdir,
  parseProjectTags,
  projectFromRow,
  projectRouteError,
  resolveProjectRow,
  uniqueProjectSlug,
} from "../core/projects.js";
import { legacyRunStatusToProcessStatus } from "../core/state-machine.js";

function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

function isSqliteConstraint(error) {
  return String(error?.code || "").includes("SQLITE_CONSTRAINT");
}

function ensureProjectWorkdir(workdir) {
  if (!workdir) return;
  try {
    mkdirSync(workdir, { recursive: true });
  } catch (error) {
    throw projectRouteError(400, "validation", `unable to create workdir: ${error.message}`);
  }
}

function projectOr404(db, value) {
  const row = resolveProjectRow(db, value);
  if (!row) throw projectRouteError(404, "not_found", "project not found");
  return row;
}

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizedProcessStatus(status, processStatus) {
  if (status !== "running" && processStatus === "running") {
    return legacyRunStatusToProcessStatus(status);
  }
  return processStatus || legacyRunStatusToProcessStatus(status);
}

function projectTaskSummary(row) {
  return {
    id: row.id,
    task_key: row.task_key || null,
    title: row.title,
    stage: row.stage || "plan",
    stage_reason: row.stage_reason || null,
    run_policy: row.run_policy || "auto_plan_execute",
    owner_agent: row.owner_agent || null,
    planner_agent: row.planner_agent || null,
    reviewer_agent: row.reviewer_agent || null,
    parent_task_id: row.parent_task_id || null,
    pending_actions: safeJson(row.pending_actions_json, []),
    blocking_issues: safeJson(row.blocking_issues_json, []),
    failure_count: row.failure_count ?? 0,
    rejection_streak: row.rejection_streak ?? 0,
    last_failure_kind: row.last_failure_kind || null,
    error_text: row.error_text || null,
    unresolved_dependency_count: Number(row.unresolved_dependency_count || 0),
    running_run_id: row.running_run_id || null,
    running_run: row.running_run_id ? {
      id: row.running_run_id,
      status: row.running_run_status,
      process_status: row.running_run_process_status || legacyRunStatusToProcessStatus(row.running_run_status),
      started_at: row.running_run_started_at,
    } : null,
    last_run: row.last_run_id ? {
      id: row.last_run_id,
      status: row.last_run_status,
      process_status: normalizedProcessStatus(row.last_run_status, row.last_run_process_status),
      failure_kind: row.last_run_failure_kind || null,
      ended_at: row.last_run_ended_at,
      stage: row.last_run_stage || (row.last_run_mode === "review" ? "review" : "execute"),
      decision: row.last_run_decision || null,
      summary: row.last_run_summary || null,
    } : null,
    updated_at: row.updated_at,
  };
}

function projectStats(db, projectId) {
  const rows = db.prepare(`
    SELECT stage, COUNT(*) AS count
    FROM tasks
    WHERE project_id = ?
    GROUP BY stage
  `).all(projectId);
  return {
    task_count: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
    by_stage: Object.fromEntries(rows.map((row) => [row.stage || "plan", row.count])),
  };
}

function normalizeProjectCreate(db, body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw projectRouteError(400, "validation", "name is required");
  return {
    name,
    slug: uniqueProjectSlug(db, { name, slug: body.slug }),
    description: typeof body.description === "string" ? body.description : "",
    context: typeof body.context === "string" ? body.context : "",
    workdir: normalizeProjectWorkdir(body.workdir, null),
    tags: parseProjectTags(body.tags),
    archived: body.archived === true ? 1 : 0,
  };
}

function normalizeProjectPatch(db, existing, body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw projectRouteError(400, "validation", "patch is required");
  }
  const fields = [];
  const values = [];

  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw projectRouteError(400, "validation", "name is required");
    fields.push("name = ?");
    values.push(name);
  }
  if ("slug" in body) {
    const nameForFallback = "name" in body && typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : existing.name;
    fields.push("slug = ?");
    values.push(uniqueProjectSlug(db, { name: nameForFallback, slug: body.slug, existingId: existing.id }));
  }
  if ("description" in body) {
    fields.push("description = ?");
    values.push(typeof body.description === "string" ? body.description : "");
  }
  if ("context" in body) {
    fields.push("context_markdown = ?");
    values.push(typeof body.context === "string" ? body.context : "");
  }
  if ("workdir" in body) {
    const workdir = normalizeProjectWorkdir(body.workdir, existing.workdir || null);
    ensureProjectWorkdir(workdir);
    fields.push("workdir = ?");
    values.push(workdir);
  }
  if ("tags" in body) {
    fields.push("tags_json = ?");
    values.push(JSON.stringify(parseProjectTags(body.tags)));
  }
  if ("archived" in body) {
    fields.push("archived = ?");
    values.push(body.archived === true ? 1 : 0);
  }
  return { fields, values };
}

export function registerProjectRoutes(app, { db, broker }) {
  app.get("/api/projects", (req, res) => {
    const includeArchived = req.query.include_archived === "true" || req.query.include_archived === "1";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where = [];
    const params = [];
    if (!includeArchived) where.push("p.archived = 0");
    if (q) {
      const like = `%${q}%`;
      where.push("(p.name LIKE ? OR p.slug LIKE ? OR p.description LIKE ? OR p.context_markdown LIKE ?)");
      params.push(like, like, like, like);
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 500));
    const rows = db.prepare(`
      SELECT
        p.*,
        COUNT(t.id) AS task_count,
        SUM(CASE WHEN t.stage <> 'done' THEN 1 ELSE 0 END) AS active_task_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY p.id
      ORDER BY p.archived ASC, p.updated_at DESC, p.name ASC
      LIMIT ?
    `).all(...params, limit);
    res.json({ projects: rows.map(projectFromRow), limit });
  });

  app.post("/api/projects", (req, res) => {
    const insertProjectRow = (project) => {
      const id = newProjectId();
      const now = Date.now();
      db.prepare(`
        INSERT INTO projects
          (id, slug, name, description, context_markdown, workdir, tags_json, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        project.slug,
        project.name,
        project.description,
        project.context,
        project.workdir,
        JSON.stringify(project.tags),
        project.archived,
        now,
        now,
      );
      return id;
    };
    try {
      const project = normalizeProjectCreate(db, req.body || {});
      ensureProjectWorkdir(project.workdir);
      let id;
      try {
        id = insertProjectRow(project);
      } catch (error) {
        if (!isSqliteConstraint(error)) throw error;
        const retry = normalizeProjectCreate(db, { ...(req.body || {}), slug: null });
        try {
          id = insertProjectRow(retry);
        } catch (retryError) {
          if (!isSqliteConstraint(retryError)) throw retryError;
          return res.status(409).json({ error: { code: "conflict", message: "project slug is already in use" } });
        }
      }
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
      broker?.broadcast?.("global", { type: "project_created", id, slug: row.slug });
      res.status(201).json({ project: projectFromRow(row) });
    } catch (error) {
      if (error?.status) return sendRouteError(res, error);
      throw error;
    }
  });

  app.get("/api/projects/:id", (req, res) => {
    try {
      const row = projectOr404(db, req.params.id);
      const tasks = db.prepare(`
        SELECT
          t.id, t.task_key, t.title, t.stage, t.stage_reason, t.run_policy,
          t.owner_agent, t.planner_agent, t.reviewer_agent, t.parent_task_id,
          t.pending_actions_json, t.blocking_issues_json, t.failure_count,
          t.rejection_streak, t.last_failure_kind, t.error_text, t.updated_at,
          (
            SELECT COUNT(*)
            FROM task_dependencies d
            JOIN tasks dep ON dep.id = d.depends_on_task_id
            WHERE d.task_id = t.id AND COALESCE(dep.stage, 'plan') <> 'done'
          ) AS unresolved_dependency_count,
          rr.id AS running_run_id,
          rr.status AS running_run_status,
          rr.process_status AS running_run_process_status,
          rr.started_at AS running_run_started_at,
          lr.id AS last_run_id,
          lr.status AS last_run_status,
          lr.process_status AS last_run_process_status,
          lr.failure_kind AS last_run_failure_kind,
          lr.ended_at AS last_run_ended_at,
          lr.stage AS last_run_stage,
          lr.mode AS last_run_mode,
          lr.decision AS last_run_decision,
          lr.summary AS last_run_summary
        FROM tasks t
        LEFT JOIN task_runs rr ON rr.id = (
          SELECT r.id
          FROM task_runs r
          WHERE r.task_id = t.id AND r.status = 'running'
          ORDER BY r.started_at DESC, r.rowid DESC
          LIMIT 1
        )
        LEFT JOIN task_runs lr ON lr.id = (
          SELECT r.id
          FROM task_runs r
          WHERE r.task_id = t.id AND r.status <> 'running'
          ORDER BY r.started_at DESC, r.rowid DESC
          LIMIT 1
        )
        WHERE t.project_id = ?
        ORDER BY t.updated_at DESC
      `).all(row.id).map(projectTaskSummary);
      res.json({
        project: {
          ...projectFromRow(row),
          stats: projectStats(db, row.id),
          tasks,
        },
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.patch("/api/projects/:id", (req, res) => {
    try {
      const existing = projectOr404(db, req.params.id);
      const { fields, values } = normalizeProjectPatch(db, existing, req.body || {});
      if (fields.length > 0) {
        fields.push("updated_at = ?");
        values.push(Date.now(), existing.id);
        try {
          db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        } catch (error) {
          if (isSqliteConstraint(error)) {
            return res.status(409).json({ error: { code: "conflict", message: "project slug is already in use" } });
          }
          throw error;
        }
      }
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(existing.id);
      const wasArchived = !!existing.archived;
      const isArchived = !!row.archived;
      if (wasArchived !== isArchived) {
        broker?.broadcast?.("global", {
          type: isArchived ? "project_archived" : "project_unarchived",
          id: row.id,
          slug: row.slug,
        });
      } else {
        broker?.broadcast?.("global", { type: "project_updated", id: row.id, slug: row.slug });
      }
      res.json({ project: projectFromRow(row) });
    } catch (error) {
      if (error?.status) return sendRouteError(res, error);
      throw error;
    }
  });

  app.delete("/api/projects/:id", (req, res) => {
    try {
      const existing = projectOr404(db, req.params.id);
      if (existing.archived) {
        return res.status(204).end();
      }
      db.prepare("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?").run(Date.now(), existing.id);
      broker?.broadcast?.("global", { type: "project_archived", id: existing.id, slug: existing.slug });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });
}
