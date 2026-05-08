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
  listRecentLeadCycles,
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

export function safeParseTeamGoalContract(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringList(value) {
  if (value == null || value === "") return [];
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function nullableTimestamp(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeCheckpointNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      return {
        at: nullableTimestamp(item.at),
        run_id: String(item.run_id || "").trim() || null,
        goal_status: String(item.goal_status || "").trim() || null,
        checkpoint_note: String(item.checkpoint_note || item.summary || "").trim(),
        validation_summary: String(item.validation_summary || "").trim(),
      };
    })
    .filter((item) => item && (item.checkpoint_note || item.validation_summary || item.goal_status || item.run_id));
}

export function normalizeTeamGoalContract(value, { teamGoal = "", now = null } = {}) {
  const parsed = safeParseTeamGoalContract(value);
  const objective = "objective" in parsed ? parsed.objective : teamGoal;
  return {
    objective: String(objective || "").trim(),
    stopping_condition: String(parsed.stopping_condition || "").trim(),
    validation_loop: String(parsed.validation_loop || "").trim(),
    constraints: stringList(parsed.constraints),
    checkpoint_notes: normalizeCheckpointNotes(parsed.checkpoint_notes).slice(-20),
    paused_at: nullableTimestamp(parsed.paused_at),
    cleared_at: nullableTimestamp(parsed.cleared_at),
    updated_at: nullableTimestamp(parsed.updated_at) || nullableTimestamp(now),
  };
}

export function serializeTeamGoalContract(contract) {
  return JSON.stringify(normalizeTeamGoalContract(contract));
}

export function initialTeamGoalContract(team, now = Date.now()) {
  return normalizeTeamGoalContract({}, { teamGoal: team?.goal || "", now });
}

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

function latestLeadCycleForProject(db, { teamId, projectId }) {
  if (!teamId || !projectId) return null;
  const row = listRecentLeadCycles(db, teamId, 50).find((cycle) => cycle.project_id === projectId);
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    project_id: row.project_id,
    process_status: row.process_status,
    status: row.status,
    failure_kind: row.failure_kind || null,
    started_at: row.started_at,
    ended_at: row.ended_at,
    summary: row.summary || null,
    cost_usd: row.cost_usd ?? null,
  };
}

export function teamProjectGoalFromRows({ team, project, root, latestCycle = null } = {}) {
  if (!team || !project || !root) return null;
  return {
    team_id: team.id,
    team_slug: team.slug,
    team_name: team.name,
    project_id: project.id,
    root_task_id: root.id,
    task_id: root.id,
    goal_status: root.goal_status || "in_progress",
    goal_status_reason: root.goal_status_reason || null,
    last_lead_at: root.last_lead_at || null,
    contract: normalizeTeamGoalContract(root.goal_contract_json, { teamGoal: team.goal || "" }),
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      archived: !!project.archived,
    },
    latest_cycle: latestCycle,
  };
}

export function getTeamProjectGoal(db, { teamId, projectId, now = Date.now(), ensureRoot = true } = {}) {
  if (!teamId || !projectId) return null;
  const team = getTeamById(db, teamId);
  const project = getProjectById(db, projectId);
  if (!team || !project || project.team_id !== teamId) return null;
  const root = ensureRoot
    ? ensureTeamRootTask(db, { teamId, projectId, now })
    : getTeamRootTask(db, { teamId, projectId });
  if (!root) return null;
  return teamProjectGoalFromRows({
    team,
    project,
    root,
    latestCycle: latestLeadCycleForProject(db, { teamId, projectId }),
  });
}

export function listTeamProjectGoals(db, teamId, { includeArchived = true, now = Date.now() } = {}) {
  const team = getTeamById(db, teamId);
  if (!team) return [];
  return listProjectsForTeam(db, teamId)
    .filter((project) => includeArchived || !project.archived)
    .map((project) => {
      const root = ensureTeamRootTask(db, { teamId, projectId: project.id, now });
      return teamProjectGoalFromRows({
        team,
        project,
        root,
        latestCycle: latestLeadCycleForProject(db, { teamId, projectId: project.id }),
      });
    })
    .filter(Boolean);
}

export function updateTeamProjectGoal(db, {
  teamId,
  projectId,
  patch = {},
  action = null,
  now = Date.now(),
} = {}) {
  const resolvedProject = listProjectsForTeam(db, teamId).find((project) => project.id === projectId || project.slug === projectId);
  const current = getTeamProjectGoal(db, { teamId, projectId: resolvedProject?.id || projectId, now });
  if (!current) return { ok: false, error: "team/project goal not found" };
  let contract = { ...current.contract };
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    if ("objective" in patch) contract.objective = String(patch.objective || "").trim();
    if ("stopping_condition" in patch) contract.stopping_condition = String(patch.stopping_condition || "").trim();
    if ("validation_loop" in patch) contract.validation_loop = String(patch.validation_loop || "").trim();
    if ("constraints" in patch) contract.constraints = stringList(patch.constraints);
  }
  if (action === "pause") {
    contract.paused_at = now;
    contract.cleared_at = null;
  } else if (action === "resume") {
    contract.paused_at = null;
  } else if (action === "clear") {
    contract.paused_at = null;
    contract.cleared_at = now;
  } else if (action && action !== "update") {
    return { ok: false, error: `unsupported goal action: ${action}` };
  }
  contract.updated_at = now;
  db.prepare("UPDATE tasks SET goal_contract_json = ?, updated_at = ? WHERE id = ?")
    .run(serializeTeamGoalContract(contract), now, current.root_task_id);
  return {
    ok: true,
    goal: getTeamProjectGoal(db, { teamId, projectId, now, ensureRoot: false }),
  };
}

export function appendTeamGoalCheckpoint(db, {
  rootTaskId,
  runId = null,
  goalStatus = null,
  checkpointNote = "",
  validationSummary = "",
  now = Date.now(),
} = {}) {
  if (!rootTaskId) return null;
  const row = db.prepare("SELECT goal_contract_json FROM tasks WHERE id = ?").get(rootTaskId);
  if (!row) return null;
  const contract = normalizeTeamGoalContract(row.goal_contract_json);
  const note = {
    at: now,
    run_id: runId || null,
    goal_status: goalStatus || null,
    checkpoint_note: String(checkpointNote || "").trim(),
    validation_summary: String(validationSummary || "").trim(),
  };
  if (note.checkpoint_note || note.validation_summary || note.goal_status || note.run_id) {
    contract.checkpoint_notes = [...contract.checkpoint_notes, note].slice(-20);
  }
  contract.updated_at = now;
  db.prepare("UPDATE tasks SET goal_contract_json = ?, updated_at = ? WHERE id = ?")
    .run(serializeTeamGoalContract(contract), now, rootTaskId);
  return contract;
}

export function leadCycleBlockedByGoal(db, { teamId, projectId, reason = "manual" } = {}) {
  if (!teamId || !projectId || reason === "manual") return null;
  const root = getTeamRootTask(db, { teamId, projectId });
  if (!root) return null;
  const contract = normalizeTeamGoalContract(root.goal_contract_json);
  if (contract.paused_at) {
    return { skipped: "goal_paused", error: "team-project goal is paused" };
  }
  if ((root.goal_status || "in_progress") === "complete") {
    return { skipped: "goal_complete", error: "team-project goal is complete" };
  }
  return null;
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
      stage, run_policy, owner_agent, goal_status, goal_contract_json, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 'execute', 'manual', ?, 'in_progress', ?, ?, ?)
  `).run(
    id, projectId, teamId, id, title, instructions, team.lead_agent || null,
    serializeTeamGoalContract(initialTeamGoalContract(team, now)),
    now, now,
  );
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
