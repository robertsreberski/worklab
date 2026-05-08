import {
  ensureTeamRootTask,
  getTeamProjectGoal,
  getTeamProjectGoalById,
  listTeamProjectGoals,
  projectRouteError,
  resolveProjectRow,
  updateTeamProjectGoal,
} from "../../core/index.js";
import { resolveTeamByIdOrSlug, listTeams as listTeamRows } from "../../core/db/queries/teams.js";
import { updateProjectFields } from "../../core/db/queries/projects.js";

const GOAL_STATES = new Set(["all", "active", "in_progress", "blocked", "paused", "complete"]);

function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

function resolveTeamOrThrow(db, value) {
  if (!value) throw projectRouteError(400, "validation", "team_id is required");
  const team = resolveTeamByIdOrSlug(db, value);
  if (!team) throw projectRouteError(400, "validation", `team not found: ${value}`);
  return team;
}

function resolveProjectOrThrow(db, value) {
  if (!value) throw projectRouteError(400, "validation", "project_id is required");
  const project = resolveProjectRow(db, value);
  if (!project) throw projectRouteError(400, "validation", `project not found: ${value}`);
  return project;
}

function goalMatchesState(goal, state) {
  if (!state || state === "all") return true;
  if (state === "paused") return Boolean(goal?.contract?.paused_at);
  if (state === "active") return !goal?.contract?.paused_at && (goal?.goal_status || "in_progress") === "in_progress";
  return !goal?.contract?.paused_at && (goal?.goal_status || "in_progress") === state;
}

function goalMatchesQuery(goal, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const contract = goal?.contract || {};
  return [
    goal?.team_name,
    goal?.team_slug,
    goal?.project?.name,
    goal?.project?.slug,
    contract.objective,
    contract.stopping_condition,
    contract.validation_loop,
    goal?.goal_status_reason,
    ...(contract.constraints || []),
  ].some((value) => String(value || "").toLowerCase().includes(q));
}

function collectGoals(db, {
  includeArchived = true,
  teamValue = null,
  projectValue = null,
  state = "all",
  query = "",
  now = Date.now(),
} = {}) {
  const teams = teamValue
    ? [resolveTeamOrThrow(db, teamValue)]
    : listTeamRows(db, { filters: [], params: [], limit: 500 });
  const project = projectValue ? resolveProjectOrThrow(db, projectValue) : null;
  return teams
    .flatMap((team) => listTeamProjectGoals(db, team.id, { includeArchived, now }))
    .filter((goal) => !project || goal.project_id === project.id)
    .filter((goal) => goalMatchesState(goal, state))
    .filter((goal) => goalMatchesQuery(goal, query))
    .sort((left, right) => {
      const leftLead = Number(left.last_lead_at || left.contract?.updated_at || 0);
      const rightLead = Number(right.last_lead_at || right.contract?.updated_at || 0);
      if (leftLead !== rightLead) return rightLead - leftLead;
      return String(left.project?.name || "").localeCompare(String(right.project?.name || ""));
    });
}

export function registerGoalRoutes(app, { db, broker, watcher }) {
  app.get("/api/goals", (req, res) => {
    try {
      const includeArchived = req.query.include_archived !== "false" && req.query.include_archived !== "0";
      const state = String(req.query.state || req.query.status || "all");
      if (!GOAL_STATES.has(state)) {
        return res.status(400).json({ error: { code: "validation", message: "invalid goal state" } });
      }
      const goals = collectGoals(db, {
        includeArchived,
        teamValue: req.query.team_id || req.query.team || null,
        projectValue: req.query.project_id || req.query.project || null,
        state,
        query: req.query.q || "",
      });
      res.json({ goals });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/goals", (req, res) => {
    try {
      const team = resolveTeamOrThrow(db, req.body?.team_id || req.body?.team);
      const project = resolveProjectOrThrow(db, req.body?.project_id || req.body?.project);
      if (project.team_id && project.team_id !== team.id) {
        return res.status(409).json({
          error: {
            code: "conflict",
            message: `project already belongs to another team: ${project.team_id}`,
          },
        });
      }

      const now = Date.now();
      const existingGoal = project.team_id === team.id
        ? getTeamProjectGoal(db, { teamId: team.id, projectId: project.id, now, ensureRoot: false })
        : null;
      if (!project.team_id) {
        updateProjectFields(db, ["team_id = ?", "updated_at = ?"], [team.id, now, project.id]);
      }
      ensureTeamRootTask(db, { teamId: team.id, projectId: project.id, now });
      const out = updateTeamProjectGoal(db, {
        teamId: team.id,
        projectId: project.id,
        patch: req.body || {},
        action: "update",
        now,
      });
      if (!out.ok) {
        return res.status(400).json({ error: { code: "validation", message: out.error || "goal create failed" } });
      }
      broker?.broadcast?.("global", {
        type: existingGoal ? "goal_updated" : "goal_created",
        goal_id: out.goal.goal_id,
        team_id: team.id,
        project_id: project.id,
      });
      res.status(existingGoal ? 200 : 201).json({ goal: out.goal });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/goals/:goal_id", (req, res) => {
    try {
      const goal = getTeamProjectGoalById(db, req.params.goal_id, { now: Date.now() });
      if (!goal) return res.status(404).json({ error: { code: "not_found", message: "goal not found" } });
      res.json({ goal });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.patch("/api/goals/:goal_id", (req, res) => {
    try {
      const current = getTeamProjectGoalById(db, req.params.goal_id, { now: Date.now() });
      if (!current) return res.status(404).json({ error: { code: "not_found", message: "goal not found" } });
      const action = typeof req.body?.action === "string" ? req.body.action.trim() : "update";
      const out = updateTeamProjectGoal(db, {
        teamId: current.team_id,
        projectId: current.project_id,
        patch: req.body || {},
        action,
        now: Date.now(),
      });
      if (!out.ok) {
        return res.status(400).json({ error: { code: "validation", message: out.error || "goal update failed" } });
      }
      broker?.broadcast?.("global", {
        type: "goal_updated",
        goal_id: out.goal.goal_id,
        team_id: out.goal.team_id,
        project_id: out.goal.project_id,
        goal_status: out.goal.goal_status,
      });
      res.json({ goal: out.goal });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/goals/:goal_id/run", (req, res) => {
    try {
      const goal = getTeamProjectGoalById(db, req.params.goal_id, { now: Date.now() });
      if (!goal) return res.status(404).json({ error: { code: "not_found", message: "goal not found" } });
      if (typeof watcher?.spawnLeadCycle !== "function") {
        return res.status(501).json({ error: { code: "not_configured", message: "lead-cycle watcher not wired" } });
      }
      const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "manual";
      const out = watcher.spawnLeadCycle({ teamId: goal.team_id, projectId: goal.project_id, reason });
      if (!out?.ok) {
        return res.status(400).json({ error: { code: out?.skipped || "invalid_state", message: out?.error || "lead cycle could not start" } });
      }
      res.status(202).json({
        ...out,
        goal_id: goal.goal_id,
        team_id: goal.team_id,
        project_id: goal.project_id,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });
}
