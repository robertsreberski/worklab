// /api/mentions/search — typeahead used by the @-mention picker.
//
// Fans out across mentionable entity types, ranks by weighted similarity
// (name, then id, then content) and recency, then returns a flat list with
// per-result `token`/`href`/`label`/`sublabel`. The picker inserts the
// canonical token at the caret on selection.

import {
  MENTION_TYPES,
  kbList,
  kbRead,
  loadSkills,
  serializeMention,
} from "../../core/index.js";
import { statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 25;

function parseLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), MAX_LIMIT));
}

function parseTypesInfo(value) {
  if (!value) return { requested: [], valid: [], types: MENTION_TYPES };
  const requested = String(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((t) => MENTION_TYPES.includes(t));
  return {
    requested,
    valid,
    types: valid.length ? valid : MENTION_TYPES,
  };
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function shapeAgent(row) {
  // Disabled agents are surfaced (sorted last by the query) because
  // they can still appear in stored prose; the picker shows them muted
  // via the `enabled` flag rather than hiding them outright.
  const id = row.name;
  const label = row.display_name?.trim() || humanize(id) || id;
  const description = row.description ? String(row.description).slice(0, 120) : null;
  return {
    token: serializeMention({ type: "agent", id }),
    type: "agent",
    id,
    label,
    sublabel: description ? `agent · ${description}` : "agent",
    href: `#/library/agents/${encodeURIComponent(id)}`,
    enabled: row.enabled !== 0,
  };
}

function shapeTask(row) {
  const id = row.task_key || row.id;
  const label = row.task_key
    ? `${row.task_key} ${row.title || ""}`.trim()
    : (row.title || row.id);
  const sublabel = row.stage ? `task · ${row.stage}` : "task";
  return {
    token: serializeMention({ type: "task", id }),
    type: "task",
    id,
    label,
    sublabel,
    href: `#/tasks/${encodeURIComponent(row.id)}`,
  };
}

function shapeProject(row) {
  const id = row.slug || row.id;
  return {
    token: serializeMention({ type: "project", id }),
    type: "project",
    id,
    label: row.name || "Unknown Project",
    sublabel: "project",
    href: `#/projects/${encodeURIComponent(row.id)}`,
  };
}

function shapeTeam(row) {
  const id = row.slug || row.id;
  return {
    token: serializeMention({ type: "team", id }),
    type: "team",
    id,
    label: row.name || "Unknown Team",
    sublabel: "team",
    href: `#/library/teams/${encodeURIComponent(row.id)}`,
  };
}

function shapeKb(meta) {
  return {
    token: serializeMention({ type: "kb", id: meta.slug }),
    type: "kb",
    id: meta.slug,
    label: meta.title || "Unknown Knowledge",
    sublabel: meta.category ? `knowledge · ${meta.category}` : "knowledge",
    href: `#/library/knowledge/${encodeURIComponent(meta.slug)}`,
  };
}

function shapeSkill(skill) {
  const id = skill.name;
  return {
    token: serializeMention({ type: "skill", id }),
    type: "skill",
    id,
    label: skill.display_name || humanize(id) || id,
    sublabel: skill.trigger ? `skill · ${String(skill.trigger).slice(0, 120)}` : "skill",
    href: `#/library/skills/${encodeURIComponent(id)}`,
    enabled: skill.enabled !== false,
  };
}

function shapeGoal(row) {
  const id = row.id;
  const project = row.project_name || "Unknown Project";
  const team = row.team_name;
  return {
    token: serializeMention({ type: "goal", id }),
    type: "goal",
    id,
    label: project,
    sublabel: team ? `goal · ${team}` : "goal",
    href: `#/goals/${encodeURIComponent(id)}`,
  };
}

function shapeRun(row) {
  const id = row.id;
  const taskLabel = row.task_key || row.task_id || "no task";
  return {
    token: serializeMention({ type: "run", id }),
    type: "run",
    id,
    label: `Run ${id} · ${taskLabel}`,
    sublabel: row.process_status ? `run · ${row.process_status}` : "run",
    href: row.task_id
      ? `#/tasks/${encodeURIComponent(row.task_id)}?run=${encodeURIComponent(id)}`
      : "#/runs",
  };
}

const SHAPERS = {
  agent: shapeAgent,
  task: shapeTask,
  project: shapeProject,
  team: shapeTeam,
  kb: shapeKb,
  skill: shapeSkill,
  goal: shapeGoal,
  run: shapeRun,
};

const FIELD_WEIGHTS = {
  name: 0,
  id: 40,
  content: 80,
};

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function textScore(value, q, base) {
  const haystack = normalizeText(value);
  if (!haystack) return Infinity;
  if (!q) return 0;
  if (haystack === q) return base;
  if (haystack.startsWith(q)) return base + 10;
  if (haystack.includes(q)) return base + 20;
  return Infinity;
}

function minFieldScore(values, q, base) {
  return values.reduce((score, value) => Math.min(score, textScore(value, q, base)), Infinity);
}

function candidateFields(type, row) {
  if (type === "agent") {
    return {
      name: [row.display_name, row.name],
      id: [row.name],
      content: [row.description, row.instructions],
      recency: row.updated_at || row.created_at || 0,
      stable: row.display_name || row.name,
    };
  }
  if (type === "task") {
    return {
      name: [row.title],
      id: [row.task_key, row.id],
      content: [row.instructions, row.plan_body],
      recency: row.updated_at || row.created_at || 0,
      stable: row.title || row.task_key || row.id,
    };
  }
  if (type === "project") {
    return {
      name: [row.name],
      id: [row.slug, row.id],
      content: [row.description, row.context_markdown],
      recency: row.updated_at || row.created_at || 0,
      stable: row.name || row.slug || row.id,
    };
  }
  if (type === "team") {
    return {
      name: [row.name],
      id: [row.slug, row.id],
      content: [row.description, row.goal],
      recency: row.updated_at || row.created_at || 0,
      stable: row.name || row.slug || row.id,
    };
  }
  if (type === "kb") {
    return {
      name: [row.title],
      id: [row.slug],
      content: [row.category, row.subcategory, row.body],
      recency: Date.parse(row.updated_at || row.created_at || "") || 0,
      stable: row.title || row.slug,
    };
  }
  if (type === "skill") {
    return {
      name: [row.display_name, row.name],
      id: [row.name],
      content: [row.trigger, row.body],
      recency: row.updated_at || 0,
      stable: row.display_name || row.name,
    };
  }
  if (type === "goal") {
    return {
      name: [row.project_name, row.team_name],
      id: [row.id, row.root_task_id, row.project_slug, row.team_slug],
      content: [row.status, row.status_reason, row.contract_json],
      recency: row.last_lead_at || row.updated_at || row.created_at || 0,
      stable: row.project_name || row.id,
    };
  }
  if (type === "run") {
    return {
      name: [row.task_title],
      id: [row.id, row.task_key, row.task_id],
      content: [row.summary, row.details, row.error_text, row.status, row.process_status],
      recency: row.started_at || row.ended_at || 0,
      stable: row.task_title || row.id,
    };
  }
  return { name: [], id: [], content: [], recency: 0, stable: "" };
}

function rankRow(type, row, q) {
  const fields = candidateFields(type, row);
  const score = Math.min(
    minFieldScore(fields.name, q, FIELD_WEIGHTS.name),
    minFieldScore(fields.id, q, FIELD_WEIGHTS.id),
    minFieldScore(fields.content, q, FIELD_WEIGHTS.content),
  );
  return {
    score,
    recency: fields.recency,
    stable: fields.stable || "",
  };
}

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

function skillUpdatedAt(skill) {
  try {
    return statSync(join(skill.assetsPath, "SKILL.md")).mtimeMs;
  } catch {
    return 0;
  }
}

function searchType(type, { db, dataDir, q, limit }) {
  if (type === "kb") {
    if (!dataDir) return [];
    return kbList({ dataDir })
      .map((meta) => {
        const entry = q ? kbRead({ dataDir, slug: meta.slug }) : null;
        return { ...meta, body: entry?.body || "" };
      })
      .slice(0, limit);
  }
  if (type === "skill") {
    if (!dataDir) return [];
    return loadSkills(join(dataDir, "skills"))
      .map((skill) => ({ ...skill, updated_at: skillUpdatedAt(skill) }))
      .slice(0, limit);
  }
  if (!db) return [];
  if (type === "goal") {
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
  if (type === "run") {
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
  if (type === "agent") {
    const where = likeWhere(["name", "display_name", "description", "instructions"], q);
    return db.prepare(`
      SELECT name, display_name, description, instructions, enabled, created_at, updated_at
      FROM agents
      WHERE ${where.clause}
      ORDER BY updated_at DESC, name
      LIMIT ?
    `).all(...where.params, limit);
  }
  if (type === "task") {
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
  if (type === "project") {
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
  if (type === "team") {
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
  return [];
}

export function searchMentions({ db, dataDir, q, types, limit }) {
  const normalizedQuery = normalizeText(q);
  const candidateLimit = Math.max(50, Math.min(250, limit * 8));
  const buckets = [];
  for (const type of types) {
    const rows = searchType(type, { db, dataDir, q: normalizedQuery, limit: candidateLimit });
    for (const row of rows) {
      const rank = rankRow(type, row, normalizedQuery);
      if (!Number.isFinite(rank.score)) continue;
      buckets.push({ rank, type, row });
    }
  }
  buckets.sort((a, b) => {
    if (a.rank.score !== b.rank.score) return a.rank.score - b.rank.score;
    if (a.rank.recency !== b.rank.recency) return b.rank.recency - a.rank.recency;
    const stable = String(a.rank.stable).localeCompare(String(b.rank.stable));
    if (stable !== 0) return stable;
    return a.type.localeCompare(b.type);
  });
  return buckets.slice(0, limit).map(({ type, row }) => SHAPERS[type](row));
}

export function registerMentionRoutes(app, { db, dataDir }) {
  app.get("/api/mentions/search", (req, res, next) => {
    try {
      const q = String(req.query.q || req.query.query || "").trim();
      const typeInfo = parseTypesInfo(req.query.types);
      if (!q && typeInfo.valid.length === 0) {
        return res.status(400).json({
          error: { code: "validation", message: "q is required" },
        });
      }
      const limit = parseLimit(req.query.limit);
      const results = searchMentions({ db, dataDir, q, types: typeInfo.types, limit });
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });
}
