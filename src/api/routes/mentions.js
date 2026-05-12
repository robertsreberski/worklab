// /api/mentions/search — typeahead used by the @-mention picker.
//
// Fans out across the five mentionable entity types, ranks results
// (exact > prefix > substring) per type, then merges into a single
// flat list with per-result `token`/`href`/`label`/`sublabel`. The
// picker inserts the canonical token at the caret on selection.

import {
  listAgentsByNamePrefix,
} from "../../core/db/queries/agents.js";
import {
  listProjectsByNamePrefix,
} from "../../core/db/queries/projects.js";
import {
  listTasksByTitlePrefix,
} from "../../core/db/queries/tasks.js";
import {
  listTeamsByNamePrefix,
} from "../../core/db/queries/teams.js";
import {
  MENTION_TYPES,
  kbListByTitlePrefix,
  loadSkills,
  serializeMention,
} from "../../core/index.js";
import { join } from "node:path";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 25;

function parseLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), MAX_LIMIT));
}

function parseTypes(value) {
  if (!value) return MENTION_TYPES;
  const requested = String(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((t) => MENTION_TYPES.includes(t));
  return valid.length ? valid : MENTION_TYPES;
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function rankPrefix(haystack, needle) {
  if (!haystack) return 4;
  const a = String(haystack).toLowerCase();
  const b = String(needle).toLowerCase();
  if (a === b) return 0;
  if (a.startsWith(b)) return 1;
  if (a.includes(b)) return 2;
  return 4;
}

function rankAgent(row, q) {
  return Math.min(
    rankPrefix(row.name, q),
    rankPrefix(row.display_name, q) + 0.1,
  );
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

function rankRow(type, row, q) {
  if (type === "agent") return rankAgent(row, q);
  if (type === "task") {
    return Math.min(
      rankPrefix(row.task_key, q),
      rankPrefix(row.title, q) + 0.1,
    );
  }
  if (type === "project") {
    return Math.min(
      rankPrefix(row.slug, q),
      rankPrefix(row.name, q) + 0.1,
    );
  }
  if (type === "team") {
    return Math.min(
      rankPrefix(row.slug, q),
      rankPrefix(row.name, q) + 0.1,
    );
  }
  if (type === "kb") {
    return Math.min(
      rankPrefix(row.slug, q),
      rankPrefix(row.title, q) + 0.1,
    );
  }
  if (type === "skill") {
    return Math.min(
      rankPrefix(row.name, q),
      rankPrefix(row.display_name, q) + 0.1,
      rankPrefix(row.trigger, q) + 0.2,
    );
  }
  if (type === "goal") {
    return Math.min(
      rankPrefix(row.id, q),
      rankPrefix(row.project_slug, q) + 0.1,
      rankPrefix(row.project_name, q) + 0.1,
      rankPrefix(row.team_slug, q) + 0.2,
      rankPrefix(row.team_name, q) + 0.2,
    );
  }
  if (type === "run") {
    return Math.min(
      rankPrefix(row.id, q),
      rankPrefix(row.task_key, q) + 0.1,
      rankPrefix(row.task_title, q) + 0.2,
    );
  }
  return 4;
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

function searchType(type, { db, dataDir, q, limit }) {
  if (type === "kb") {
    if (!dataDir) return [];
    return kbListByTitlePrefix({ dataDir, query: q, limit });
  }
  if (type === "skill") {
    if (!dataDir) return [];
    const needle = q.toLowerCase();
    return loadSkills(join(dataDir, "skills"))
      .filter((skill) => [
        skill.name,
        skill.display_name,
        skill.trigger,
      ].some((value) => String(value || "").toLowerCase().includes(needle)))
      .slice(0, limit);
  }
  if (type === "goal") {
    if (!db) return [];
    const like = `%${q}%`;
    return db.prepare(`
      SELECT
        g.id,
        g.status,
        g.project_id,
        g.team_id,
        g.root_task_id,
        p.name AS project_name,
        p.slug AS project_slug,
        t.name AS team_name,
        t.slug AS team_slug
      FROM goals g
      LEFT JOIN projects p ON p.id = g.project_id
      LEFT JOIN teams t ON t.id = g.team_id
      WHERE g.id LIKE ?
         OR g.root_task_id LIKE ?
         OR p.name LIKE ?
         OR p.slug LIKE ?
         OR t.name LIKE ?
         OR t.slug LIKE ?
      ORDER BY COALESCE(g.last_lead_at, g.updated_at) DESC
      LIMIT ?
    `).all(like, like, like, like, like, like, limit);
  }
  if (type === "run") {
    if (!db) return [];
    const like = `%${q}%`;
    return db.prepare(`
      SELECT
        r.id,
        r.task_id,
        r.mode,
        r.stage,
        r.status,
        r.process_status,
        r.started_at,
        t.task_key,
        t.title AS task_title
      FROM task_runs r
      LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.id LIKE ?
         OR t.task_key LIKE ?
         OR t.title LIKE ?
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT ?
    `).all(like, like, like, limit);
  }
  switch (type) {
    case "agent": return listAgentsByNamePrefix(db, q, limit);
    case "task": return listTasksByTitlePrefix(db, q, limit);
    case "project": return listProjectsByNamePrefix(db, q, limit);
    case "team": return listTeamsByNamePrefix(db, q, limit);
    default: return [];
  }
}

export function searchMentions({ db, dataDir, q, types, limit }) {
  const perTypeLimit = Math.max(3, Math.ceil(limit / types.length));
  const buckets = [];
  for (const type of types) {
    const rows = searchType(type, { db, dataDir, q, limit: perTypeLimit });
    for (const row of rows) {
      const rank = rankRow(type, row, q);
      buckets.push({ rank, type, row });
    }
  }
  buckets.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.type.localeCompare(b.type);
  });
  return buckets.slice(0, limit).map(({ type, row }) => SHAPERS[type](row));
}

export function registerMentionRoutes(app, { db, dataDir }) {
  app.get("/api/mentions/search", (req, res, next) => {
    try {
      const q = String(req.query.q || req.query.query || "").trim();
      if (!q) {
        return res.status(400).json({
          error: { code: "validation", message: "q is required" },
        });
      }
      const types = parseTypes(req.query.types);
      const limit = parseLimit(req.query.limit);
      const results = searchMentions({ db, dataDir, q, types, limit });
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });
}
