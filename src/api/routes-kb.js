import { z } from "zod";
import { kbList, kbRead, kbCreate, kbUpdate, kbDelete } from "../core/kb.js";

const CreateSchema = z.object({
  slug: z.string(),
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

export function registerKbRoutes(app, { dataDir, broker }) {
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

    const { slug, title, body, tags, category, pinned } = parsed.data;
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
}
