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
  serializeMention,
} from "../../core/index.js";

const DEFAULT_LIMIT = 8;
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
    label: row.name || id,
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
    label: row.name || id,
    sublabel: "team",
    href: `#/library/teams/${encodeURIComponent(row.id)}`,
  };
}

function shapeKb(meta) {
  return {
    token: serializeMention({ type: "kb", id: meta.slug }),
    type: "kb",
    id: meta.slug,
    label: meta.title || meta.slug,
    sublabel: meta.category ? `knowledge · ${meta.category}` : "knowledge",
    href: `#/library/knowledge/${encodeURIComponent(meta.slug)}`,
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
  return 4;
}

const SHAPERS = {
  agent: shapeAgent,
  task: shapeTask,
  project: shapeProject,
  team: shapeTeam,
  kb: shapeKb,
};

function searchType(type, { db, dataDir, q, limit }) {
  if (type === "kb") {
    if (!dataDir) return [];
    return kbListByTitlePrefix({ dataDir, query: q, limit });
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
