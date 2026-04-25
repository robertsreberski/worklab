import { z } from "zod";
import { kbList, kbRead, kbCreate, kbUpdate, kbDelete } from "../core/kb.js";
import { uniqueSlug } from "../core/slugs.js";

const CreateSchema = z.object({
  slug: z.string().optional(),
  title: z.string(),
  body: z.string().optional().default(""),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

const PatchSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

export function registerKbRoutes(app, { dataDir, broker, db }) {
  // GET /api/kb?tag=&category=&pinned=
  app.get("/api/kb", (req, res) => {
    const { tag, category } = req.query;
    let pinned;
    if (req.query.pinned === "true") pinned = true;
    else if (req.query.pinned === "false") pinned = false;
    // else leave undefined (no filter)

    const filter = {};
    if (tag !== undefined) filter.tag = tag;
    if (category !== undefined) filter.category = category;
    if (pinned !== undefined) filter.pinned = pinned;

    const entries = kbList({ dataDir, ...filter });
    res.json({ entries });
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
    res.json({ entry });
  });

  // POST /api/kb
  app.post("/api/kb", (req, res) => {
    const parsed = CreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid request body" },
      });
    }

    const { title, body, tags, category, pinned } = parsed.data;
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
    res.status(201).json({ entry });
  });

  // PATCH /api/kb/:slug
  app.patch("/api/kb/:slug", (req, res) => {
    const parsed = PatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid request body" },
      });
    }

    let entry;
    try {
      entry = kbUpdate({ dataDir, slug: req.params.slug, patch: parsed.data });
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
    res.json({ entry });
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
    for (const row of db.prepare("SELECT id, title, instructions, stage FROM tasks").all()) {
      if (matches(row.title) || matches(row.instructions)) {
        if (!seenTasks.has(row.id)) {
          seenTasks.add(row.id);
          tasks.push({ id: row.id, title: row.title, stage: row.stage, via: "body" });
        }
      }
    }
    for (const row of db.prepare("SELECT task_id, body FROM task_comments").all()) {
      if (matches(row.body) && !seenTasks.has(row.task_id)) {
        const task = db.prepare("SELECT id, title, stage FROM tasks WHERE id = ?").get(row.task_id);
        if (task) {
          seenTasks.add(task.id);
          tasks.push({ id: task.id, title: task.title, stage: task.stage, via: "comment" });
        }
      }
    }

    const agents = [];
    for (const row of db.prepare("SELECT name, display_name, instructions FROM agents").all()) {
      if (matches(row.instructions)) {
        agents.push({ name: row.name, display_name: row.display_name });
      }
    }

    res.json({ tasks, agents });
  });
}
