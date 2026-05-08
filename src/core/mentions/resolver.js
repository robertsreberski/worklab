// Resolves mention tokens (`@agent/triager`, `@task/T-42`, ...) into
// display + navigation metadata so the UI can render badges and the
// LLM-expansion path can replace tokens with readable text. The
// resolver is the single source of truth for "what does this mention
// point at right now"; renames flow through it without a DB rewrite.

import { getAgentByName } from "../db/queries/agents.js";
import { getTaskById, getTaskByKey } from "../db/queries/tasks.js";
import { resolveProjectByIdOrSlug } from "../db/queries/projects.js";
import { resolveTeamByIdOrSlug } from "../db/queries/teams.js";
import { kbReadMeta } from "../kb.js";
import { parseMentions, parseMentionToken, MENTION_TYPES } from "./tokens.js";

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function agentResolved(item, row) {
  if (!row) return missing(item);
  const label = row.display_name || humanize(row.name) || row.name;
  return {
    token: item.token,
    type: "agent",
    id: row.name,
    label,
    sublabel: "agent",
    href: `#/agents/${encodeURIComponent(row.name)}`,
    exists: true,
  };
}

function taskResolved(item, row) {
  if (!row) return missing(item);
  const key = row.task_key || row.id;
  const title = String(row.title || "").trim();
  const label = title ? `${key} ${title}` : key;
  return {
    token: item.token,
    type: "task",
    id: row.task_key || row.id,
    label,
    sublabel: "task",
    href: `#/tasks/${encodeURIComponent(row.id)}`,
    exists: true,
  };
}

function projectResolved(item, row) {
  if (!row) return missing(item);
  return {
    token: item.token,
    type: "project",
    id: row.slug || row.id,
    label: row.name || row.slug || row.id,
    sublabel: "project",
    href: `#/projects/${encodeURIComponent(row.id)}`,
    exists: true,
  };
}

function teamResolved(item, row) {
  if (!row) return missing(item);
  return {
    token: item.token,
    type: "team",
    id: row.slug || row.id,
    label: row.name || row.slug || row.id,
    sublabel: "team",
    href: `#/teams/${encodeURIComponent(row.id)}`,
    exists: true,
  };
}

function kbResolved(item, meta) {
  if (!meta) return missing(item);
  return {
    token: item.token,
    type: "kb",
    id: meta.slug,
    label: meta.title || meta.slug,
    sublabel: "knowledge",
    href: `#/knowledge/${encodeURIComponent(meta.slug)}`,
    exists: true,
  };
}

function missing(item) {
  return {
    token: item.token,
    type: item.type,
    id: item.id,
    label: item.token,
    sublabel: item.type,
    href: null,
    exists: false,
  };
}

function tokenItems(input) {
  // Accepts either an array of tokens or raw text we should parse.
  if (Array.isArray(input)) {
    const items = [];
    for (const tok of input) {
      const parsed = parseMentionToken(tok);
      if (parsed) items.push(parsed);
    }
    return items;
  }
  return parseMentions(input || "").map(({ token, type, id }) => ({ token, type, id }));
}

function groupByType(items) {
  const groups = new Map();
  for (const item of items) {
    if (!MENTION_TYPES.includes(item.type)) continue;
    if (!groups.has(item.type)) groups.set(item.type, []);
    groups.get(item.type).push(item);
  }
  return groups;
}

export function resolveMentions(db, input, { dataDir = null } = {}) {
  const items = tokenItems(input);
  const out = new Map();
  if (items.length === 0) return out;
  // Dedupe: identical tokens resolve once, then re-attach to every
  // occurrence in the input.
  const byToken = new Map();
  for (const item of items) {
    if (!byToken.has(item.token)) byToken.set(item.token, item);
  }
  const groups = groupByType(Array.from(byToken.values()));

  for (const item of groups.get("agent") || []) {
    const row = db ? getAgentByName(db, item.id) : null;
    out.set(item.token, agentResolved(item, row));
  }
  for (const item of groups.get("task") || []) {
    let row = db ? getTaskById(db, item.id) : null;
    if (!row && db) row = getTaskByKey(db, item.id);
    out.set(item.token, taskResolved(item, row));
  }
  for (const item of groups.get("project") || []) {
    const row = db ? resolveProjectByIdOrSlug(db, item.id) : null;
    out.set(item.token, projectResolved(item, row));
  }
  for (const item of groups.get("team") || []) {
    const row = db ? resolveTeamByIdOrSlug(db, item.id) : null;
    out.set(item.token, teamResolved(item, row));
  }
  for (const item of groups.get("kb") || []) {
    const meta = dataDir ? kbReadMeta({ dataDir, slug: item.id }) : null;
    out.set(item.token, kbResolved(item, meta));
  }

  return out;
}

export function resolvedMentionsToObject(map) {
  const out = {};
  for (const [token, value] of map) out[token] = value;
  return out;
}
