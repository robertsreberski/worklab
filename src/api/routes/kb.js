import { z } from "zod";
import {
  compactProject,
  kbCreate,
  kbDelete,
  kbList,
  kbRead,
  kbUpdate,
  resolveProjectRow,
  uniqueSlug,
} from "../../core/index.js";
import {
  getTaskHeaderForKbUsage,
  listTaskHeadersForKbUsage,
} from "../../core/db/queries/tasks.js";
import { listAllCommentBodiesForKbUsage } from "../../core/db/queries/comments.js";
import { listAgentInstructionsForKbUsage } from "../../core/db/queries/agents.js";

const CreateSchema = z.object({
  slug: z.string().optional(),
  title: z.string(),
  body: z.string().optional().default(""),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

const PatchSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

function resolveKbProjectId(db, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!db) return String(value).trim() || null;
  const row = resolveProjectRow(db, value);
  if (!row) {
    const err = new Error(`project not found: ${value}`);
    err.status = 400;
    err.code = "validation";
    throw err;
  }
  return row.id;
}

function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

function projectMap(db, projectIds) {
  const out = new Map();
  if (!db) return out;
  for (const id of [...new Set(projectIds.filter(Boolean))]) {
    const row = resolveProjectRow(db, id);
    if (row) out.set(id, compactProject(row));
  }
  return out;
}

function attachProjects(db, entries) {
  const rows = Array.isArray(entries) ? entries : [entries].filter(Boolean);
  const projects = projectMap(db, rows.map((entry) => entry?.project_id || entry?.meta?.project_id));
  const attach = (entry) => {
    if (!entry) return entry;
    const projectId = entry.project_id || entry.meta?.project_id || null;
    return { ...entry, project: projectId ? projects.get(projectId) || null : null };
  };
  return Array.isArray(entries) ? entries.map(attach) : attach(entries);
}

export function registerKbRoutes(app, { dataDir, broker, db }) {
  // GET /api/kb?tag=&category=&subcategory=&project_id=&pinned=
  app.get("/api/kb", (req, res) => {
    const { tag, category, subcategory } = req.query;
    let pinned;
    if (req.query.pinned === "true") pinned = true;
    else if (req.query.pinned === "false") pinned = false;
    // else leave undefined (no filter)

    const filter = {};
    if (tag !== undefined) filter.tag = tag;
    if (category !== undefined) filter.category = category;
    if (subcategory !== undefined) filter.subcategory = subcategory;
    if (pinned !== undefined) filter.pinned = pinned;
    try {
      if (req.query.project_id !== undefined) filter.project_id = resolveKbProjectId(db, req.query.project_id);
    } catch (error) {
      return sendRouteError(res, error);
    }

    const entries = kbList({ dataDir, ...filter });
    res.json({ entries: attachProjects(db, entries) });
  });

  // GET /api/kb/:slug
  app.get("/api/kb/:slug", (req, res) => {
    let entry;
    try {
      entry = kbRead({ dataDir, slug: req.params.slug });
    } catch (err) {
      if (err.message.startsWith("invalid slug")) {
        return res.status(400).json({ error: { code: "invalid_slug", message: err.message } });
      }
      throw err;
    }
    if (!entry) {
      return res.status(404).json({ error: { code: "not_found", message: "kb entry not found" } });
    }
    res.json({ entry: attachProjects(db, entry) });
  });

  // POST /api/kb
  app.post("/api/kb", (req, res) => {
    const parsed = CreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid request body" },
      });
    }

    let projectId;
    try {
      projectId = resolveKbProjectId(db, parsed.data.project_id);
    } catch (error) {
      return sendRouteError(res, error);
    }
    const { title, body, tags, category, subcategory, pinned } = parsed.data;
    const slug = parsed.data.slug || uniqueSlug(title, (candidate) => Boolean(kbRead({ dataDir, slug: candidate })), {
      fallback: "entry",
    });
    let entry;
    try {
      entry = kbCreate({
        dataDir,
        slug,
        title,
        body,
        tags,
        category,
        subcategory,
        project_id: projectId,
        pinned,
        author: "human",
      });
    } catch (err) {
      if (err.message.startsWith("invalid slug")) {
        return res.status(400).json({ error: { code: "invalid_slug", message: err.message } });
      }
      if (err.message.includes("already exists")) {
        return res.status(409).json({ error: { code: "conflict", message: err.message } });
      }
      throw err;
    }

    broker.broadcast("global", { type: "kb_updated", slug });
    res.status(201).json({ entry: attachProjects(db, entry) });
  });

  // PATCH /api/kb/:slug
  app.patch("/api/kb/:slug", (req, res) => {
    const parsed = PatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid request body" },
      });
    }

    const patch = { ...parsed.data };
    if ("project_id" in patch) {
      try {
        patch.project_id = resolveKbProjectId(db, patch.project_id);
      } catch (error) {
        return sendRouteError(res, error);
      }
    }
    let entry;
    try {
      entry = kbUpdate({ dataDir, slug: req.params.slug, patch });
    } catch (err) {
      if (err.message.startsWith("invalid slug")) {
        return res.status(400).json({ error: { code: "invalid_slug", message: err.message } });
      }
      if (err.message.includes("not_found")) {
        return res.status(404).json({ error: { code: "not_found", message: "kb entry not found" } });
      }
      throw err;
    }

    broker.broadcast("global", { type: "kb_updated", slug: req.params.slug });
    res.json({ entry: attachProjects(db, entry) });
  });

  // DELETE /api/kb/:slug
  app.delete("/api/kb/:slug", (req, res) => {
    let deleted;
    try {
      deleted = kbDelete({ dataDir, slug: req.params.slug });
    } catch (err) {
      if (err.message.startsWith("invalid slug")) {
        return res.status(400).json({ error: { code: "invalid_slug", message: err.message } });
      }
      throw err;
    }

    if (!deleted) {
      return res.status(404).json({ error: { code: "not_found", message: "kb entry not found" } });
    }

    broker.broadcast("global", { type: "kb_updated", slug: req.params.slug });
    res.status(204).end();
  });

  // Reverse links: which tasks and agents mention this entry by slug or title.
  // The scan is a substring match — cheap, good enough for a single-user tool.
  // Takes 10-50ms at typical corpus sizes and runs on demand, not on list.
  app.get("/api/kb/:slug/usage", (req, res) => {
    if (!db) return res.json({ tasks: [], agents: [] });
    const slug = req.params.slug;
    let entry;
    try {
      entry = kbRead({ dataDir, slug });
    } catch (err) {
      if (err.message.startsWith("invalid slug")) {
        return res.status(400).json({ error: { code: "invalid_slug", message: err.message } });
      }
      throw err;
    }
    if (!entry) return res.status(404).json({ error: { code: "not_found", message: "kb entry not found" } });

    const needles = [slug];
    if (entry.title && entry.title.toLowerCase() !== slug.toLowerCase()) needles.push(entry.title);

    const matches = (haystack) => {
      const h = (haystack || "").toLowerCase();
      return needles.some((n) => h.includes(n.toLowerCase()));
    };

    const tasks = [];
    const seenTasks = new Set();
    for (const row of listTaskHeadersForKbUsage(db)) {
      if (matches(row.title) || matches(row.instructions)) {
        if (!seenTasks.has(row.id)) {
          seenTasks.add(row.id);
          tasks.push({ id: row.id, task_key: row.task_key || null, title: row.title, stage: row.stage, via: "body" });
        }
      }
    }
    for (const row of listAllCommentBodiesForKbUsage(db)) {
      if (matches(row.body) && !seenTasks.has(row.task_id)) {
        const task = getTaskHeaderForKbUsage(db, row.task_id);
        if (task) {
          seenTasks.add(task.id);
          tasks.push({ id: task.id, task_key: task.task_key || null, title: task.title, stage: task.stage, via: "comment" });
        }
      }
    }

    const agents = [];
    for (const row of listAgentInstructionsForKbUsage(db)) {
      if (matches(row.instructions)) {
        agents.push({ name: row.name, display_name: row.display_name });
      }
    }

    res.json({ tasks, agents });
  });
}
