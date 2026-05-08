// Team admin tools. Mirrors projects/agents tool shapes; routes through the
// REST endpoints registered by src/api/routes/teams.js so the MCP surface
// and the UI surface stay consistent.

import {
  arrayOfString,
  boolean,
  number,
  object,
  patchSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

const memberSchema = object({
  agent_name: string("Agent name to include in the team roster"),
  role_description: string("Optional short role description for this agent on the team"),
}, ["agent_name"]);

const teamCreateInput = object({
  name: string("Team name"),
  slug: string("Optional URL-safe slug"),
  description: string("Short description"),
  goal: string("Team goal — used by the lead agent to reason about progress"),
  lead_agent: string("Name of the lead agent (must be enabled)"),
  status: string("Team status: active or archived"),
  schedule_enabled: boolean("If true, the team-lead cron triggers periodic lead cycles"),
  schedule_interval_minutes: number("How often the lead cycle should run when schedule_enabled is true (minutes)"),
  daily_budget_usd: number("Daily team budget in USD (replaces per-agent budgets)"),
  per_run_budget_usd: number("Per-run team budget in USD"),
  members: { type: "array", items: memberSchema, description: "Optional initial member roster" },
}, ["name"]);

export const definitions = [
  tool("worklab_team_list", "List teams, optionally filtered by status or text query.", object({
    q: string("Search query"),
    status: string("Filter by status: active or archived"),
    include_archived: boolean("Include archived teams when no status filter is supplied"),
    limit: number("Max teams to return"),
  })),
  tool("worklab_team_get", "Get a team with its roster, assigned projects, and recent lead cycles.", object({
    id: string("Team id or slug"),
  }, ["id"])),
  tool("worklab_team_create", "Create a team. Returns the team plus member roster.", teamCreateInput),
  tool("worklab_team_update", "Patch a team. Use fields accepted by PATCH /api/teams/:id, plus an optional members array to replace the roster.", object({
    id: string("Team id or slug"),
    patch: patchSchema,
  }, ["id", "patch"])),
  tool("worklab_team_delete", "Archive a team (soft-delete). Use worklab_team_delete_permanent to drop the row.", object({
    id: string("Team id or slug"),
  }, ["id"])),
  tool("worklab_team_delete_permanent", "Permanently delete a team and its members. Projects assigned to the team revert to team_id=null.", object({
    id: string("Team id or slug"),
  }, ["id"])),
  tool("worklab_team_members_set", "Replace the team roster atomically.", object({
    id: string("Team id or slug"),
    members: { type: "array", items: memberSchema, description: "Members to install" },
  }, ["id", "members"])),
  tool("worklab_team_run_lead", "Manually enqueue a lead cycle for one (or all assigned) projects.", object({
    id: string("Team id or slug"),
    project_id: string("Optional: limit to a single assigned project (id or slug)"),
    reason: string("Optional reason label persisted with the cycle"),
  }, ["id"])),
  tool("worklab_team_cycles", "List recent lead cycles for a team.", object({
    id: string("Team id or slug"),
    limit: number("Max cycles to return (default 50)"),
  }, ["id"])),
  tool("worklab_team_goals", "List per-project durable goals for a team.", object({
    id: string("Team id or slug"),
    include_archived: boolean("Include archived project goals"),
  }, ["id"])),
  tool("worklab_team_goal_update", "Edit or control one team-project goal. Use action pause, resume, or clear for lifecycle controls.", object({
    id: string("Team id or slug"),
    project_id: string("Assigned project id or slug"),
    objective: string("Concrete objective for this team-project goal"),
    stopping_condition: string("Verifiable stopping condition"),
    validation_loop: string("Commands or artifacts that prove progress"),
    constraints: arrayOfString("Constraints the lead must respect"),
    action: string("Optional lifecycle action: update, pause, resume, or clear"),
  }, ["id", "project_id"])),
  tool("worklab_team_assign_project", "Assign a project to a team (alias for worklab_project_update with team_id).", object({
    team_id: string("Team id or slug; pass null/empty to unassign"),
    project_id: string("Project id or slug to assign"),
  }, ["project_id"])),
];

const specs = [
  ["worklab_team_list", "GET", "/api/teams", ["q", "status", "include_archived", "limit"]],
  ["worklab_team_get", "GET", "/api/teams/:id"],
  ["worklab_team_create", "POST", "/api/teams", [], "input"],
  ["worklab_team_update", "PATCH", "/api/teams/:id", [], "patch"],
  ["worklab_team_delete", "DELETE", "/api/teams/:id"],
  ["worklab_team_delete_permanent", "DELETE", "/api/teams/:id/permanent"],
  ["worklab_team_members_set", "PUT", "/api/teams/:id/members", [], "members"],
  ["worklab_team_run_lead", "POST", "/api/teams/:id/run-lead", [], "input"],
  ["worklab_team_cycles", "GET", "/api/teams/:id/cycles", ["limit"]],
  ["worklab_team_goals", "GET", "/api/teams/:id/goals", ["include_archived"]],
  ["worklab_team_goal_update", "PATCH", "/api/teams/:id/goals/:project_id", [], "input"],
];

export function buildHandlers(client) {
  const handlers = buildSpecHandlers(client, specs);

  handlers.worklab_team_assign_project = async (input = {}) => {
    const projectId = input.project_id;
    if (!projectId) throw new Error("project_id is required");
    const teamId = input.team_id == null ? null : input.team_id;
    const { apiRequest } = await import("../../shared/tool-registry.js");
    return apiRequest(client, "PATCH", `/api/projects/${encodeURIComponent(projectId)}`, {
      body: { team_id: teamId },
    });
  };

  return handlers;
}
