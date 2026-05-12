// Resolves mention tokens (`@agent/triager`, `@task/T-42`, ...) into
// display + navigation metadata so the UI can render badges and the
// LLM-expansion path can replace tokens with readable text. The
// resolver is the single source of truth for "what does this mention
// point at right now"; renames flow through it without a DB rewrite.

import { getAgentByName } from "../db/queries/agents.js";
import { getTaskById, getTaskByKey } from "../db/queries/tasks.js";
import { resolveProjectByIdOrSlug } from "../db/queries/projects.js";
import { resolveTeamByIdOrSlug } from "../db/queries/teams.js";
import { getRunById } from "../db/queries/runs.js";
import { kbReadMeta } from "../kb.js";
import { loadSkills } from "../skills.js";
import { parseMentions, parseMentionToken, MENTION_TYPES } from "./tokens.js";
import { join } from "node:path";

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
    href: `#/library/agents/${encodeURIComponent(row.name)}`,
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
    href: `#/library/teams/${encodeURIComponent(row.id)}`,
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
    href: `#/library/knowledge/${encodeURIComponent(meta.slug)}`,
    exists: true,
  };
}

function skillResolved(item, skill) {
  if (!skill) return missing(item);
  return {
    token: item.token,
    type: "skill",
    id: skill.name,
    label: skill.display_name || humanize(skill.name) || skill.name,
    sublabel: "skill",
    href: `#/library/skills/${encodeURIComponent(skill.name)}`,
    exists: true,
  };
}

function goalResolved(item, row) {
  if (!row) return missing(item);
  const label = row.project_name || row.project_slug || row.project_id || row.id;
  const sublabel = row.team_name ? `goal · ${row.team_name}` : "goal";
  return {
    token: item.token,
    type: "goal",
    id: row.id,
    label,
    sublabel,
    href: `#/goals/${encodeURIComponent(row.id)}`,
    exists: true,
  };
}

function runResolved(item, row) {
  if (!row) return missing(item);
  const taskLabel = row.task_key || row.task_id || "no task";
  return {
    token: item.token,
    type: "run",
    id: row.id,
    label: `Run ${row.id} · ${taskLabel}`,
    sublabel: row.process_status ? `run · ${row.process_status}` : "run",
    href: row.task_id
      ? `#/tasks/${encodeURIComponent(row.task_id)}?run=${encodeURIComponent(row.id)}`
      : `#/runs`,
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

function getSkillByName(dataDir, name) {
  if (!dataDir || !name) return null;
  return loadSkills(join(dataDir, "skills")).find((skill) => skill.name === name) || null;
}

function getGoalMentionRow(db, id) {
  if (!db || !id) return null;
  return db.prepare(`
    SELECT
      g.id,
      g.project_id,
      g.team_id,
      g.root_task_id,
      g.status,
      p.name AS project_name,
      p.slug AS project_slug,
      t.name AS team_name,
      t.slug AS team_slug
    FROM goals g
    LEFT JOIN projects p ON p.id = g.project_id
    LEFT JOIN teams t ON t.id = g.team_id
    WHERE g.id = ? OR g.root_task_id = ?
    LIMIT 1
  `).get(id, id);
}

function getRunMentionRow(db, id) {
  if (!db || !id) return null;
  const row = getRunById(db, id);
  if (!row) return null;
  const task = row.task_id
    ? db.prepare("SELECT task_key, title FROM tasks WHERE id = ?").get(row.task_id)
    : null;
  return {
    ...row,
    task_key: task?.task_key || null,
    task_title: task?.title || null,
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
  for (const item of groups.get("skill") || []) {
    out.set(item.token, skillResolved(item, getSkillByName(dataDir, item.id)));
  }
  for (const item of groups.get("goal") || []) {
    out.set(item.token, goalResolved(item, getGoalMentionRow(db, item.id)));
  }
  for (const item of groups.get("run") || []) {
    out.set(item.token, runResolved(item, getRunMentionRow(db, item.id)));
  }

  return out;
}

export function resolvedMentionsToObject(map) {
  const out = {};
  for (const [token, value] of map) out[token] = value;
  return out;
}
