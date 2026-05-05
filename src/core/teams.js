// Team domain helpers. Sit on top of src/core/db/queries/teams.js. Owned by
// the watcher (delegation roster + lead-cycle scheduling) and by the API/MCP
// edge layers (CRUD payload shaping).

import { isValidSlug, uniqueSlug } from "./slugs.js";
import {
  archiveTeam as archiveTeamRow,
  getTeamById,
  getTeamRootTask,
  getTeamRosterAgentNames,
  hasInFlightLeadCycle as hasInFlightLeadCycleRow,
  insertTeam,
  listTeamMembers,
  listProjectsForTeam,
  listTeams as listTeamsRow,
  listTeamRootTasks,
  resolveTeamByIdOrSlug,
  updateTeamFields,
} from "./db/queries/teams.js";
import { getProjectById } from "./db/queries/projects.js";
import { newTaskId, newTeamId } from "./ids.js";
import { projectRouteError } from "./projects.js";

export const TEAM_STATUSES = ["active", "archived"];

export function teamFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    goal: row.goal || "",
    lead_agent: row.lead_agent || null,
    status: TEAM_STATUSES.includes(row.status) ? row.status : "active",
    schedule_enabled: !!row.schedule_enabled,
    schedule_interval_minutes: row.schedule_interval_minutes ?? null,
    daily_budget_usd: row.daily_budget_usd ?? null,
    per_run_budget_usd: row.per_run_budget_usd ?? null,
    last_lead_cycle_at: row.last_lead_cycle_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    member_count: row.member_count ?? undefined,
    project_count: row.project_count ?? undefined,
  };
}

export function normalizeTeamSlug(value) {
  if (value === undefined || value === null || value === "") return null;
  const slug = String(value).trim().toLowerCase();
  if (!isValidSlug(slug)) {
    throw projectRouteError(400, "validation", "slug must use lowercase letters, digits, and hyphens");
  }
  return slug;
}

export function uniqueTeamSlug(db, { name, slug, existingId = null }) {
  const requested = normalizeTeamSlug(slug);
  const candidate = uniqueSlug(requested || name, (value) => {
    const row = resolveTeamByIdOrSlug(db, value);
    return !!(row && row.id !== existingId);
  }, { fallback: "team" });
  if (!isValidSlug(candidate)) {
    throw projectRouteError(400, "validation", "slug must use lowercase letters, digits, and hyphens");
  }
  return candidate;
}

export function listTeams(db, { status = null, includeArchived = false, limit = 200 } = {}) {
  const filters = [];
  const params = [];
  if (status) { filters.push("t.status = ?"); params.push(status); }
  else if (!includeArchived) { filters.push("t.status <> 'archived'"); }
  return listTeamsRow(db, { filters, params, limit }).map(teamFromRow);
}

export function getTeam(db, idOrSlug) {
  const row = resolveTeamByIdOrSlug(db, idOrSlug);
  return row ? teamFromRow(row) : null;
}

export function loadTeamRoster(db, teamId) {
  if (!teamId) return null;
  const team = getTeamById(db, teamId);
  if (!team) return null;
  return {
    team_id: team.id,
    lead_agent: team.lead_agent || null,
    member_agents: getTeamRosterAgentNames(db, team.id),
  };
}

// Team that "owns" a task: explicit task.team_id wins, otherwise inherit from
// the project. Returns null when neither is set (no roster restriction).
export function effectiveTeamForTask(db, task) {
  if (!task) return null;
  if (task.team_id) return task.team_id;
  if (!task.project_id) return null;
  const proj = getProjectById(db, task.project_id);
  return proj?.team_id || null;
}

export function resolveEffectiveTeamForProject(db, projectId) {
  if (!projectId) return null;
  const proj = getProjectById(db, projectId);
  return proj?.team_id || null;
}

// Roster check that replaces enforceProjectAgentAllowlist. Pass the team id
// (already resolved by the caller) and the candidate agent names; offenders
// are everyone outside the lead+members set.
export function enforceTeamRoster(db, { teamId, candidates = [] } = {}) {
  if (!teamId) return { ok: true, warnings: [] };
  const roster = getTeamRosterAgentNames(db, teamId);
  if (!roster.length) {
    return {
      ok: false,
      failureKind: "delegation_team_roster_empty",
      error: `team ${teamId} has no roster (lead + members) configured`,
      offenders: [],
      allowed: [],
    };
  }
  const allowed = new Set(roster);
  const seen = new Set();
  const offenders = [];
  for (const name of candidates) {
    const value = String(name || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (!allowed.has(value)) offenders.push(value);
  }
  if (offenders.length === 0) return { ok: true, warnings: [], roster };
  const list = roster.map((n) => `"${n}"`).join(", ");
  const offList = offenders.map((n) => `"${n}"`).join(", ");
  return {
    ok: false,
    failureKind: "delegation_agent_not_in_team",
    error: offenders.length === 1
      ? `agent ${offList} is not in the team roster [${list}]`
      : `agents ${offList} are not in the team roster [${list}]`,
    offenders,
    allowed: roster,
  };
}

export { hasInFlightLeadCycleRow as hasInFlightLeadCycle };

// Idempotent: ensure the synthetic root task for (team, project) exists. The
// row is hidden from default listings (is_team_root = 1) and acts as the
// anchor for all lead_cycle runs and the parent of lead-created subtasks.
export function ensureTeamRootTask(db, { teamId, projectId, now = Date.now() } = {}) {
  if (!teamId || !projectId) return null;
  const existing = getTeamRootTask(db, { teamId, projectId });
  if (existing) return existing;
  const team = getTeamById(db, teamId);
  const project = getProjectById(db, projectId);
  if (!team || !project) return null;
  const id = newTaskId();
  const title = `[team] ${team.name} → ${project.name}`;
  const instructions = team.goal
    ? `Team goal:\n${team.goal}\n\n(synthetic root task; lead cycle anchor for team "${team.name}" on project "${project.name}")`
    : `(synthetic root task; lead cycle anchor for team "${team.name}" on project "${project.name}")`;
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, team_id, is_team_root, root_task_id, title, instructions,
      stage, run_policy, owner_agent, goal_status, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 'execute', 'manual', ?, 'in_progress', ?, ?)
  `).run(id, projectId, teamId, id, title, instructions, team.lead_agent || null, now, now);
  return getTeamRootTask(db, { teamId, projectId });
}

// Ensure roots for every project this team is currently assigned to. Called
// after team creation/update or after a project is reassigned.
export function ensureAllTeamRootTasks(db, teamId, now = Date.now()) {
  const projects = listProjectsForTeam(db, teamId);
  const out = [];
  for (const p of projects) {
    if (p.archived) continue;
    const root = ensureTeamRootTask(db, { teamId, projectId: p.id, now });
    if (root) out.push(root);
  }
  return out;
}

// Schedule a lead-cycle run for (team, project). Caller is responsible for
// gating on hasInFlightLeadCycle when debouncing event triggers.
//
// We don't insert a `task_runs` row here — runs are only created by the
// watcher via spawnTaskRun. Instead we return a descriptor the caller hands
// to spawnLeadCycleRun (in src/coordinator/team-lead-cron.js / watcher).
export function enqueueLeadCycle(db, { teamId, projectId, reason = "manual", now = Date.now() } = {}) {
  if (!teamId || !projectId) return { ok: false, error: "teamId and projectId required" };
  const team = getTeamById(db, teamId);
  if (!team) return { ok: false, error: "team not found" };
  if (!team.lead_agent) return { ok: false, error: "team has no lead_agent configured" };
  if (team.status !== "active") return { ok: false, error: "team is archived" };
  const root = ensureTeamRootTask(db, { teamId, projectId, now });
  if (!root) return { ok: false, error: "could not resolve synthetic root task" };
  return {
    ok: true,
    teamId,
    projectId,
    rootTaskId: root.id,
    leadAgent: team.lead_agent,
    reason,
  };
}

export {
  archiveTeamRow as archiveTeam,
  insertTeam,
  listProjectsForTeam,
  listTeamMembers,
  listTeamRootTasks,
  updateTeamFields,
};
