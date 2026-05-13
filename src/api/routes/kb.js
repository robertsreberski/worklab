import { z } from "zod";
import {
  compactProject,
  autoPromotedRunResultInfo,
  kbEntryClassification,
  kbCreate,
  kbDelete,
  kbList,
  kbRead,
  kbTaxonomy,
  kbUpdate,
  normalizeKbSort,
  resolveProjectRow,
  uniqueSlug,
} from "../../core/index.js";
import {
  getTaskHeaderForKbUsage,
  listProjectTaskTextForKbUsage,
  listTaskHeadersForKbUsage,
} from "../../core/db/queries/tasks.js";
import {
  listAllCommentBodiesForKbUsage,
  listProjectCommentBodiesForKbUsage,
} from "../../core/db/queries/comments.js";
import { listAgentInstructionsForKbUsage } from "../../core/db/queries/agents.js";
import { listProjectsForKbTagMatching } from "../../core/db/queries/projects.js";
import { runExists } from "../../core/db/queries/runs.js";
import { withMentions } from "../lib/with-mentions.js";

const CreateSchema = z.object({
  slug: z.string().optional(),
  title: z.string(),
  body: z.string().optional().default(""),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  artifact: z.boolean().nullable().optional(),
  project_id: z.string().nullable().optional(),
  source_task_id: z.string().nullable().optional(),
  source_task_key: z.string().nullable().optional(),
  source_run_id: z.string().nullable().optional(),
  source_agent: z.string().nullable().optional(),
  related_slugs: z.array(z.string()).optional(),
  supersedes_slugs: z.array(z.string()).optional(),
  canonical_slug: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

const PatchSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  artifact: z.boolean().nullable().optional(),
  project_id: z.string().nullable().optional(),
  source_task_id: z.string().nullable().optional(),
  source_task_key: z.string().nullable().optional(),
  source_run_id: z.string().nullable().optional(),
  source_agent: z.string().nullable().optional(),
  related_slugs: z.array(z.string()).optional(),
  supersedes_slugs: z.array(z.string()).optional(),
  canonical_slug: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

const OrganizeSchema = z.object({
  apply: z.boolean().optional().default(false),
});

const CleanupAutoPromotedSchema = z.object({
  apply: z.boolean().optional().default(false),
});

const SUBCATEGORY_TAGS = [
  "ui-audit",
  "runtime",
  "observability",
  "datasets",
  "harnesses",
  "benchmarks",
  "prs",
  "pr-import",
  "migration",
  "redirects",
  "accessibility",
  "responsive",
  "fixtures",
  "design-system",
  "level-design",
  "battle",
  "progression",
  "content-pipeline",
  "live-smoke",
  "complexity",
  "qa",
];

const NOISY_SUBCATEGORY_TAGS = new Set([
  "run-result",
  "execute",
  "research",
  "audit",
  "approved",
  "approve",
  "implementation",
  "validation",
  "evidence",
  "automattic",
  "benchmark",
  "benchmark-reset",
  "automattic-benchmark",
  "automattic-benchmark-reset",
  "pokemario",
  "wpcom",
  "wp-sandbox",
]);

const UNKNOWN_KNOWLEDGE_TITLE = "Unknown Knowledge";

function slugToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function entryText(meta) {
  return [
    meta.slug,
    meta.title,
    meta.category,
    meta.subcategory,
    ...(Array.isArray(meta.tags) ? meta.tags : []),
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

function hasSignal(text, token) {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

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

function resolveKnowledgeRelation(dataDir, slug) {
  const cleanSlug = String(slug || "").trim();
  if (!cleanSlug) return null;
  try {
    const entry = kbRead({ dataDir, slug: cleanSlug });
    if (entry?.meta?.slug) {
      return {
        slug: entry.meta.slug,
        title: entry.meta.title || UNKNOWN_KNOWLEDGE_TITLE,
      };
    }
  } catch {
    // Invalid or stale relation slugs should still render as unresolved badges.
  }
  return { slug: cleanSlug, title: UNKNOWN_KNOWLEDGE_TITLE, missing: true };
}

function resolveKnowledgeRelations(dataDir, slugs) {
  return (Array.isArray(slugs) ? slugs : [])
    .map((slug) => resolveKnowledgeRelation(dataDir, slug))
    .filter(Boolean);
}

function attachKnowledgeRelations(dataDir, entries) {
  const attach = (entry) => {
    if (!entry?.meta) return entry;
    const canonicalEntry = resolveKnowledgeRelation(dataDir, entry.meta.canonical_slug);
    return {
      ...entry,
      meta: {
        ...entry.meta,
        canonical_entry: canonicalEntry,
        related_entries: resolveKnowledgeRelations(dataDir, entry.meta.related_slugs),
        supersedes_entries: resolveKnowledgeRelations(dataDir, entry.meta.supersedes_slugs),
      },
    };
  };
  return Array.isArray(entries) ? entries.map(attach) : attach(entries);
}

function attachAutoPromotedInfo(dataDir, entries) {
  const rows = Array.isArray(entries) ? entries : [entries].filter(Boolean);
  const attach = (entry) => {
    if (!entry) return entry;
    const slug = entry.slug || entry.meta?.slug;
    if (!slug) return { ...entry, auto_promoted: false };
    try {
      const full = entry.body !== undefined && entry.meta
        ? entry
        : { meta: entry.meta || entry, body: "" };
      const info = autoPromotedRunResultInfo(full || entry);
      const classification = kbEntryClassification(entry.meta ? { ...entry.meta, ...info } : { ...entry, ...info }, {
        autoPromoted: info.auto_promoted,
      });
      if (entry.meta) {
        return {
          ...entry,
          meta: { ...entry.meta, ...info, ...classification },
          auto_promoted: info.auto_promoted,
          ...classification,
        };
      }
      return { ...entry, ...info, ...classification };
    } catch {
      return { ...entry, auto_promoted: false };
    }
  };
  return Array.isArray(entries) ? rows.map(attach) : attach(entries);
}

function sourceRunExists(db, runId) {
  if (!db || !runId) return false;
  return runExists(db, runId);
}

function autoPromotedCleanupCandidates({ dataDir, db }) {
  return kbList({ dataDir })
    .map((meta) => {
      const entry = kbRead({ dataDir, slug: meta.slug });
      if (!entry) return null;
      const info = autoPromotedRunResultInfo(entry);
      const exists = sourceRunExists(db, info.source_run_id);
      if (!info.auto_promoted || entry.meta.pinned || !exists) return null;
      return {
        slug: entry.meta.slug,
        title: entry.meta.title || entry.meta.slug,
        project_id: entry.meta.project_id || null,
        source_run_id: info.source_run_id,
        source_task_ref: info.source_task_ref,
        source_agent: info.source_agent,
        source_run_exists: exists,
        updated_at: entry.meta.updated_at || null,
      };
    })
    .filter(Boolean);
}

function taskUsageProjectId(db, entry) {
  if (!db) return null;
  const slug = entry.slug || entry.meta?.slug;
  const title = entry.title || entry.meta?.title || "";
  const needles = [slug, title].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return null;
  const matches = (text) => {
    const haystack = String(text || "").toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  };
  const counts = new Map();
  const add = (projectId) => {
    if (!projectId) return;
    counts.set(projectId, (counts.get(projectId) || 0) + 1);
  };
  for (const row of listProjectTaskTextForKbUsage(db)) {
    if (matches(row.title) || matches(row.instructions)) add(row.project_id);
  }
  for (const row of listProjectCommentBodiesForKbUsage(db)) {
    if (matches(row.body)) add(row.project_id);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[1][1] === ranked[0][1]) return null;
  return ranked[0][0];
}

function projectAliases(project) {
  const aliases = new Set([slugToken(project.slug), slugToken(project.name)]);
  const nameParts = slugToken(project.name).split("-").filter((part) => part.length > 4);
  for (const part of nameParts) aliases.add(part);
  try {
    const tags = JSON.parse(project.tags_json || "[]");
    for (const tag of Array.isArray(tags) ? tags : []) {
      const alias = slugToken(tag);
      if (alias.length > 3) aliases.add(alias);
    }
  } catch {
    // Ignore malformed project tags; project matching falls back to slug/name.
  }
  return [...aliases].filter(Boolean);
}

function tagProjectId(db, meta) {
  if (!db) return null;
  const tokens = new Set([
    slugToken(meta.slug),
    slugToken(meta.title),
    ...(Array.isArray(meta.tags) ? meta.tags.map(slugToken) : []),
  ].filter(Boolean));
  const matches = [];
  const projects = listProjectsForKbTagMatching(db);
  for (const project of projects) {
    const aliases = projectAliases(project);
    if (aliases.some((alias) => tokens.has(alias))) matches.push(project);
  }
  const active = matches.filter((project) => !project.archived);
  const candidates = active.length ? active : matches;
  return candidates.length === 1 ? candidates[0].id : null;
}

function inferCategory(meta) {
  const current = String(meta.category || "").trim();
  if (current && current !== "uncategorized") return null;
  const text = entryText(meta);
  if (hasSignal(text, "qa")) return "qa";
  if (hasSignal(text, "run-result") || hasSignal(text, "final-answer") || String(meta.slug || "").startsWith("run-")) return "run-results";
  if (hasSignal(text, "decision") || hasSignal(text, "strategy")) return "decision";
  if (hasSignal(text, "runbook")) return "runbook";
  if (hasSignal(text, "operations")) return "operations";
  if (hasSignal(text, "audit") || hasSignal(text, "research") || hasSignal(text, "brief") || hasSignal(text, "inventory") || hasSignal(text, "map")) return "research";
  return null;
}

function inferSubcategory(meta) {
  if (meta.subcategory) return null;
  const text = entryText(meta);
  for (const tag of SUBCATEGORY_TAGS) {
    if (hasSignal(text, tag)) return tag;
  }
  const candidate = (Array.isArray(meta.tags) ? meta.tags : [])
    .map(slugToken)
    .find((tag) => tag && !NOISY_SUBCATEGORY_TAGS.has(tag) && !tag.startsWith("task-") && !tag.startsWith("agent-"));
  return candidate || null;
}

function organizeProposalForEntry({ db, entry }) {
  const meta = entry.meta || entry;
  const patch = {};
  const reasons = [];
  if (Array.isArray(meta.raw_tags) && meta.raw_tags.length && JSON.stringify(meta.raw_tags) !== JSON.stringify(meta.tags || [])) {
    patch.tags = meta.tags || [];
    reasons.push("tags");
  }
  if (meta.raw_category && meta.category && meta.raw_category !== meta.category) {
    patch.category = meta.category;
    reasons.push("category");
  }
  if (meta.raw_subcategory && meta.subcategory && meta.raw_subcategory !== meta.subcategory) {
    patch.subcategory = meta.subcategory;
    reasons.push("subcategory");
  }
  if (!meta.project_id) {
    const projectId = taskUsageProjectId(db, meta) || tagProjectId(db, meta);
    if (projectId) {
      patch.project_id = projectId;
      reasons.push("project");
    }
  }
  const category = inferCategory({ ...meta, ...patch });
  if (category && category !== meta.category) {
    patch.category = category;
    reasons.push("category");
  }
  const subcategory = inferSubcategory({ ...meta, ...patch });
  if (subcategory && subcategory !== meta.subcategory) {
    patch.subcategory = subcategory;
    reasons.push("subcategory");
  }
  if (!Object.keys(patch).length) return null;
  return {
    slug: meta.slug,
    title: meta.title || meta.slug,
    patch,
    reasons,
  };
}

export function registerKbRoutes(app, { dataDir, broker, db }) {
  // GET /api/kb?tag=&category=&subcategory=&project_id=&pinned=
  app.get("/api/kb", (req, res) => {
    const { tag, category, subcategory } = req.query;
    let pinned;
    if (req.query.pinned === "true") pinned = true;
    else if (req.query.pinned === "false") pinned = false;
    // else leave undefined (no filter)
    let sort;
    try {
      sort = normalizeKbSort(req.query.sort);
    } catch (error) {
      return sendRouteError(res, error);
    }

    const filter = {};
    if (tag !== undefined) filter.tag = tag;
    if (category !== undefined) filter.category = category;
    if (subcategory !== undefined) filter.subcategory = subcategory;
    if (pinned !== undefined) filter.pinned = pinned;
    filter.sort = sort;
    try {
      if (req.query.project_id !== undefined) filter.project_id = resolveKbProjectId(db, req.query.project_id);
    } catch (error) {
      return sendRouteError(res, error);
    }

    const entries = attachAutoPromotedInfo(dataDir, kbList({ dataDir, ...filter }));
    res.json({ entries: attachProjects(db, entries) });
  });

  // GET /api/kb/taxonomy
  app.get("/api/kb/taxonomy", (_req, res) => {
    res.json(kbTaxonomy({ dataDir }));
  });

  // POST /api/kb/organize
  app.post("/api/kb/organize", (req, res) => {
    const parsed = OrganizeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid request body" },
      });
    }
    const apply = parsed.data.apply === true;
    const entries = kbList({ dataDir }).map((meta) => kbRead({ dataDir, slug: meta.slug })).filter(Boolean);
    const proposals = entries
      .map((entry) => organizeProposalForEntry({ db, entry }))
      .filter(Boolean);
    let applied = 0;
    if (apply) {
      for (const proposal of proposals) {
        kbUpdate({ dataDir, slug: proposal.slug, patch: proposal.patch });
        broker.broadcast("global", { type: "kb_updated", slug: proposal.slug });
        applied += 1;
      }
    }
    res.json({
      ok: true,
      apply,
      count: entries.length,
      proposed: proposals.length,
      applied,
      proposals: attachProjects(db, proposals),
    });
  });

  // POST /api/kb/cleanup-auto-promoted
  app.post("/api/kb/cleanup-auto-promoted", (req, res) => {
    const parsed = CleanupAutoPromotedSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid request body" },
      });
    }
    const apply = parsed.data.apply === true;
    const candidates = autoPromotedCleanupCandidates({ dataDir, db });
    let deleted = 0;
    if (apply) {
      for (const candidate of candidates) {
        if (kbDelete({ dataDir, slug: candidate.slug })) {
          broker?.broadcast?.("global", { type: "kb_updated", slug: candidate.slug });
          deleted += 1;
        }
      }
    }
    res.json({
      ok: true,
      apply,
      count: kbList({ dataDir }).length + deleted,
      proposed: candidates.length,
      deleted,
      candidates: attachProjects(db, candidates),
    });
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
    const enriched = attachKnowledgeRelations(dataDir, attachProjects(db, attachAutoPromotedInfo(dataDir, entry)));
    res.json(withMentions(
      { db, dataDir },
      { entry: enriched },
      [enriched.body, enriched.meta?.title],
    ));
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
    const {
      title,
      body,
      tags,
      category,
      subcategory,
      artifact,
      pinned,
      source_task_id,
      source_task_key,
      source_run_id,
      source_agent,
      related_slugs,
      supersedes_slugs,
      canonical_slug,
    } = parsed.data;
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
        artifact,
        project_id: projectId,
        source_task_id,
        source_task_key,
        source_run_id,
        source_agent,
        related_slugs,
        supersedes_slugs,
        canonical_slug,
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
    res.status(201).json({ entry: attachProjects(db, attachAutoPromotedInfo(dataDir, entry)) });
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
    res.json({ entry: attachProjects(db, attachAutoPromotedInfo(dataDir, entry)) });
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
