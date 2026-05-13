// Teams REST surface. Mirrors src/api/routes/projects.js conventions:
// validation throws projectRouteError; broker.broadcast publishes "global"
// channel events; the watcher proxy provides spawnLeadCycle for the manual
// run-lead endpoint. SQL access goes exclusively through the queries layer.

import {
  newTeamId,
  projectRouteError,
  TEAM_STATUSES,
  ensureTeamRootTask,
  listTeamProjectGoals,
  teamFromRow,
  updateTeamProjectGoal,
  uniqueTeamSlug,
} from "../../core/index.js";
import {
  archiveTeam,
  clearTeamMembers,
  deleteTeam,
  getTeamById,
  insertTeam,
  insertTeamMember,
  listProjectsForTeam,
  listRecentLeadCycles,
  listTeamMembers,
  listTeams,
  resolveTeamByIdOrSlug,
  updateTeamFields,
} from "../../core/db/queries/teams.js";
import { getEnabledAgentByName, agentExists } from "../../core/db/queries/agents.js";
import { withMentions } from "../lib/with-mentions.js";

function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

function teamOr404(db, value) {
  const row = resolveTeamByIdOrSlug(db, value);
  if (!row) throw projectRouteError(404, "not_found", "team not found");
  return row;
}

function memberOut(row) {
  return {
    agent_name: row.agent_name,
    display_name: row.display_name || row.agent_name,
    role_description: row.role_description || "",
    enabled: !!row.enabled,
    created_at: row.created_at,
  };
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (value == null || value === "") return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function leadCycleOut(row) {
  return {
    id: row.id,
    run_id: row.run_id || row.id,
    task_id: row.task_id,
    team_id: row.team_id,
    project_id: row.project_id,
    kind: row.kind,
    process_status: row.process_status,
    status: row.status,
    failure_kind: row.failure_kind || null,
    started_at: row.started_at,
    ended_at: row.ended_at,
    cost_usd: row.cost_usd ?? null,
    summary: row.summary || null,
    checkpoint_note: row.checkpoint_note || null,
    validation_summary: row.validation_summary || null,
    task_deletions: safeJsonArray(row.task_deletions_json),
    task_creation_skips: safeJsonArray(row.task_creation_skips_json),
    goal_refinement: safeJsonObject(row.goal_refinement_json),
    goal_refinement_applied: safeJsonObject(row.goal_refinement_applied_json),
    goal_status: row.goal_status || null,
    goal_status_reason: row.goal_status_reason || null,
    next_review_due_at: row.next_review_due_at ?? null,
    next_review_event: row.next_review_event || null,
    next_review_consumed_at: row.next_review_consumed_at ?? null,
    tasks_created: row.tasks_created || 0,
    tasks_assigned: row.tasks_assigned || 0,
    tasks_deleted: row.tasks_deleted || 0,
    tasks_skipped: row.tasks_skipped || 0,
    notes_posted: row.notes_posted || 0,
    task_title: row.task_title || null,
  };
}

function ensureLeadAgentEnabled(db, name) {
  if (name === undefined) return undefined;
  if (name === null || name === "") return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const agent = getEnabledAgentByName(db, trimmed);
  if (!agent) throw projectRouteError(400, "validation", `lead_agent must reference an enabled agent (got "${trimmed}")`);
  return trimmed;
}

function normalizeNumberField(key, value, { allowNull = true } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return allowNull ? null : 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw projectRouteError(400, "validation", `${key} must be a non-negative number`);
  }
  return n;
}

function normalizeIntervalMinutes(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw projectRouteError(400, "validation", "schedule_interval_minutes must be a positive integer");
  }
  return n;
}

function normalizeStatus(value, fallback = "active") {
  if (value === undefined) return undefined;
  const v = String(value || "").trim();
  if (!v) return fallback;
  if (!TEAM_STATUSES.includes(v)) {
    throw projectRouteError(400, "validation", `status must be one of: ${TEAM_STATUSES.join(", ")}`);
  }
  return v;
}

function normalizeMembersInput(value) {
  if (!Array.isArray(value)) {
    throw projectRouteError(400, "validation", "members must be an array");
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw projectRouteError(400, "validation", "each member must be an object");
    }
    const agentName = String(item.agent_name || "").trim();
    if (!agentName) throw projectRouteError(400, "validation", "member.agent_name is required");
    if (seen.has(agentName)) continue;
    seen.add(agentName);
    out.push({
      agent_name: agentName,
      role_description: String(item.role_description || "").trim(),
    });
  }
  return out;
}

function buildTeamCreate(db, body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw projectRouteError(400, "validation", "name is required");
  return {
    name,
    slug: uniqueTeamSlug(db, { name, slug: body.slug }),
    description: typeof body.description === "string" ? body.description : "",
    goal: typeof body.goal === "string" ? body.goal : "",
    leadAgent: ensureLeadAgentEnabled(db, body.lead_agent) ?? null,
    status: normalizeStatus(body.status, "active") || "active",
    scheduleEnabled: body.schedule_enabled === true ? 1 : 0,
    scheduleIntervalMinutes: normalizeIntervalMinutes(body.schedule_interval_minutes) ?? null,
    dailyBudgetUsd: normalizeNumberField("daily_budget_usd", body.daily_budget_usd) ?? null,
    perRunBudgetUsd: normalizeNumberField("per_run_budget_usd", body.per_run_budget_usd) ?? null,
  };
}

function buildTeamPatch(db, existing, body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw projectRouteError(400, "validation", "patch is required");
  }
  const fields = [];
  const values = [];
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw projectRouteError(400, "validation", "name is required");
    fields.push("name = ?"); values.push(name);
  }
  if ("slug" in body) {
    const nameForFallback = "name" in body && typeof body.name === "string" && body.name.trim()
      ? body.name.trim() : existing.name;
    fields.push("slug = ?"); values.push(uniqueTeamSlug(db, { name: nameForFallback, slug: body.slug, existingId: existing.id }));
  }
  if ("description" in body) {
    fields.push("description = ?"); values.push(typeof body.description === "string" ? body.description : "");
  }
  if ("goal" in body) {
    fields.push("goal = ?"); values.push(typeof body.goal === "string" ? body.goal : "");
  }
  if ("lead_agent" in body) {
    fields.push("lead_agent = ?"); values.push(ensureLeadAgentEnabled(db, body.lead_agent));
  }
  if ("status" in body) {
    const status = normalizeStatus(body.status, existing.status || "active");
    fields.push("status = ?"); values.push(status);
  }
  if ("schedule_enabled" in body) {
    fields.push("schedule_enabled = ?"); values.push(body.schedule_enabled === true ? 1 : 0);
  }
  if ("schedule_interval_minutes" in body) {
    fields.push("schedule_interval_minutes = ?"); values.push(normalizeIntervalMinutes(body.schedule_interval_minutes) ?? null);
  }
  if ("daily_budget_usd" in body) {
    fields.push("daily_budget_usd = ?"); values.push(normalizeNumberField("daily_budget_usd", body.daily_budget_usd) ?? null);
  }
  if ("per_run_budget_usd" in body) {
    fields.push("per_run_budget_usd = ?"); values.push(normalizeNumberField("per_run_budget_usd", body.per_run_budget_usd) ?? null);
  }
  return { fields, values };
}

function applyTeamMembers(db, teamId, members, now) {
  for (const m of members) {
    if (!agentExists(db, m.agent_name)) {
      throw projectRouteError(400, "validation", `member agent not found: ${m.agent_name}`);
    }
  }
  clearTeamMembers(db, teamId);
  for (const m of members) {
    insertTeamMember(db, {
      teamId,
      agentName: m.agent_name,
      roleDescription: m.role_description,
      createdAt: now,
    });
  }
}

export function registerTeamRoutes(app, { db, broker, watcher, dataDir }) {
  app.get("/api/teams", (req, res) => {
    try {
      const includeArchived = req.query.include_archived === "true" || req.query.include_archived === "1";
      const status = typeof req.query.status === "string" && req.query.status.trim()
        ? req.query.status.trim() : null;
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 500));
      const filters = [];
      const params = [];
      if (status) {
        if (!TEAM_STATUSES.includes(status)) {
          return res.status(400).json({ error: { code: "validation", message: `status must be one of: ${TEAM_STATUSES.join(", ")}` } });
        }
        filters.push("t.status = ?"); params.push(status);
      } else if (!includeArchived) {
        filters.push("t.status <> 'archived'");
      }
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (q) {
        const like = `%${q}%`;
        filters.push("(t.name LIKE ? OR t.slug LIKE ? OR t.description LIKE ? OR t.goal LIKE ?)");
        params.push(like, like, like, like);
      }
      const rows = listTeams(db, { filters, params, limit });
      res.json({ teams: rows.map(teamFromRow), limit });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/teams", (req, res) => {
    try {
      const team = buildTeamCreate(db, req.body || {});
      const id = newTeamId();
      const now = Date.now();
      insertTeam(db, {
        id,
        slug: team.slug,
        name: team.name,
        description: team.description,
        goal: team.goal,
        leadAgent: team.leadAgent,
        status: team.status,
        scheduleEnabled: team.scheduleEnabled,
        scheduleIntervalMinutes: team.scheduleIntervalMinutes,
        dailyBudgetUsd: team.dailyBudgetUsd,
        perRunBudgetUsd: team.perRunBudgetUsd,
        createdAt: now,
        updatedAt: now,
      });
      const members = Array.isArray(req.body?.members) ? normalizeMembersInput(req.body.members) : [];
      if (members.length) applyTeamMembers(db, id, members, now);
      const row = getTeamById(db, id);
      broker?.broadcast?.("global", { type: "team_created", id, slug: row.slug });
      res.status(201).json({ team: teamFromRow(row), members: listTeamMembers(db, id).map(memberOut) });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/teams/:id/goals", (req, res) => {
    try {
      const row = teamOr404(db, req.params.id);
      const includeArchived = req.query.include_archived === "true" || req.query.include_archived === "1";
      res.json({ goals: listTeamProjectGoals(db, row.id, { includeArchived, now: Date.now() }) });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.patch("/api/teams/:id/goals/:project_id", (req, res) => {
    try {
      const row = teamOr404(db, req.params.id);
      const action = typeof req.body?.action === "string" ? req.body.action.trim() : null;
      const out = updateTeamProjectGoal(db, {
        teamId: row.id,
        projectId: req.params.project_id,
        patch: req.body || {},
        action,
        now: Date.now(),
      });
      if (!out.ok) {
        return res.status(400).json({ error: { code: "validation", message: out.error || "goal update failed" } });
      }
      broker?.broadcast?.("global", {
        type: "team_goal_updated",
        team_id: row.id,
        project_id: out.goal.project_id,
        goal_status: out.goal.goal_status,
      });
      res.json({ goal: out.goal });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/teams/:id", (req, res) => {
    try {
      const row = teamOr404(db, req.params.id);
      const team = teamFromRow(row);
      const members = listTeamMembers(db, row.id).map(memberOut);
      const projects = listProjectsForTeam(db, row.id);
      const cycles = listRecentLeadCycles(db, row.id, 50).map(leadCycleOut);
      const goals = listTeamProjectGoals(db, row.id, { includeArchived: true, now: Date.now() });
      res.json(withMentions(
        { db, dataDir },
        { team, members, projects, recent_cycles: cycles, goals },
        [team.goal, team.description, goals.map((g) => g?.goal)],
      ));
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.patch("/api/teams/:id", (req, res) => {
    try {
      const existing = teamOr404(db, req.params.id);
      const { fields, values } = buildTeamPatch(db, existing, req.body || {});
      const now = Date.now();
      if (fields.length > 0) {
        fields.push("updated_at = ?");
        values.push(now, existing.id);
        try {
          updateTeamFields(db, fields, values);
        } catch (error) {
          if (String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
            return res.status(409).json({ error: { code: "conflict", message: "team slug is already in use" } });
          }
          throw error;
        }
      }
      if (Array.isArray(req.body?.members)) {
        const members = normalizeMembersInput(req.body.members);
        applyTeamMembers(db, existing.id, members, now);
      }
      const row = getTeamById(db, existing.id);
      broker?.broadcast?.("global", { type: "team_updated", id: row.id, slug: row.slug });
      res.json({ team: teamFromRow(row), members: listTeamMembers(db, existing.id).map(memberOut) });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.delete("/api/teams/:id", (req, res) => {
    try {
      const existing = teamOr404(db, req.params.id);
      if (existing.status === "archived") return res.status(204).end();
      archiveTeam(db, existing.id, Date.now());
      broker?.broadcast?.("global", { type: "team_archived", id: existing.id, slug: existing.slug });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.put("/api/teams/:id/members", (req, res) => {
    try {
      const existing = teamOr404(db, req.params.id);
      const members = normalizeMembersInput(req.body?.members || []);
      const now = Date.now();
      applyTeamMembers(db, existing.id, members, now);
      updateTeamFields(db, ["updated_at = ?"], [now, existing.id]);
      broker?.broadcast?.("global", { type: "team_members_updated", id: existing.id, slug: existing.slug });
      res.json({ members: listTeamMembers(db, existing.id).map(memberOut) });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/teams/:id/cycles", (req, res) => {
    try {
      const existing = teamOr404(db, req.params.id);
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      const cycles = listRecentLeadCycles(db, existing.id, limit).map(leadCycleOut);
      res.json({ cycles, limit });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/teams/:id/run-lead", (req, res) => {
    try {
      const existing = teamOr404(db, req.params.id);
      if (existing.status !== "active") {
        return res.status(400).json({ error: { code: "team_archived", message: "team is archived" } });
      }
      if (!existing.lead_agent) {
        return res.status(400).json({ error: { code: "no_lead", message: "team has no lead_agent configured" } });
      }
      const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim() : "manual";
      const projectIdInput = req.body?.project_id;
      const projects = listProjectsForTeam(db, existing.id).filter((p) => !p.archived);
      if (!projects.length) {
        return res.status(400).json({ error: { code: "no_projects", message: "team has no active projects assigned" } });
      }
      const targets = projectIdInput
        ? projects.filter((p) => p.id === projectIdInput || p.slug === projectIdInput)
        : projects;
      if (!targets.length) {
        return res.status(400).json({ error: { code: "validation", message: `project not assigned to team: ${projectIdInput}` } });
      }
      if (typeof watcher?.spawnLeadCycle !== "function") {
        return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
      }
      const results = [];
      for (const project of targets) {
        // Pre-create the internal root so lead-cycle runs have a stable
        // parent even if the spawn is skipped.
        try { ensureTeamRootTask(db, { teamId: existing.id, projectId: project.id, now: Date.now() }); }
        catch { /* best-effort */ }
        const out = watcher.spawnLeadCycle({ teamId: existing.id, projectId: project.id, reason });
        results.push({ project_id: project.id, ...(out || { ok: false, error: "watcher unavailable" }) });
      }
      res.status(202).json({ results });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.delete("/api/teams/:id/permanent", (req, res) => {
    try {
      const existing = teamOr404(db, req.params.id);
      deleteTeam(db, existing.id);
      broker?.broadcast?.("global", { type: "team_archived", id: existing.id, slug: existing.slug });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });
}
