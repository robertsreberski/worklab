import { getRunWarningsAndDiagnostics } from "../../core/db/queries/runs.js";
import { getTeamById } from "../../core/db/queries/teams.js";
import { readSettings } from "../../core/settings.js";
import { safeParseJson } from "./run-handler.js";

// v33: budget cascade is workspace -> team -> team-per-run. Per-agent caps
// were retired in favour of team caps. Tasks/runs without an effective team
// only see the workspace cap. Lead-cycle runs count against the team's
// budget, which bounds runaway scheduled cycles.
function startOfTodayUtcMs() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function teamSpendSince(db, teamId, sinceMs) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM task_runs
    WHERE team_id = ? AND started_at >= ? AND cost_usd IS NOT NULL
  `).get(teamId, sinceMs);
  return Number(row?.total || 0);
}

function workspaceSpendSince(db, sinceMs) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM task_runs
    WHERE started_at >= ? AND cost_usd IS NOT NULL
  `).get(sinceMs);
  return Number(row?.total || 0);
}

export function checkBudget({ db, agentName, teamId = null }) {
  const settings = readSettings(db);
  const since = startOfTodayUtcMs();
  const workspaceSpend = workspaceSpendSince(db, since);
  const workspaceBudget = Number(settings.daily_budget_usd || 0);
  if (workspaceBudget > 0 && workspaceSpend >= workspaceBudget) {
    return {
      ok: false,
      scope: "workspace",
      spent: workspaceSpend,
      cap: workspaceBudget,
      message: `Daily workspace budget reached ($${workspaceSpend.toFixed(4)} of $${workspaceBudget.toFixed(2)}).`,
    };
  }
  if (teamId) {
    const team = getTeamById(db, teamId);
    const cap = Number(team?.daily_budget_usd || 0);
    if (cap > 0) {
      const spend = teamSpendSince(db, teamId, since);
      if (spend >= cap) {
        const label = team?.name || teamId;
        return {
          ok: false,
          scope: "team_daily",
          spent: spend,
          cap,
          team_id: teamId,
          message: `Daily budget for team ${label} reached ($${spend.toFixed(4)} of $${cap.toFixed(2)}).`,
        };
      }
    }
  }
  return { ok: true, agentName, teamId, workspaceSpend };
}

export function recordPerRunBudgetOverage({ db, runId, agentName, teamId = null, costUsd }) {
  const cost = Number(costUsd);
  if (!Number.isFinite(cost)) return;
  let cap = 0;
  let label = agentName;
  if (teamId) {
    const team = getTeamById(db, teamId);
    cap = Number(team?.per_run_budget_usd || 0);
    label = team?.name || teamId;
  }
  if (!(cap > 0) || cost <= cap) {
    db.prepare("UPDATE task_runs SET cost_usd = COALESCE(cost_usd, ?) WHERE id = ?").run(cost, runId);
    return;
  }

  const row = getRunWarningsAndDiagnostics(db, runId);
  if (!row) return;
  const warning = {
    kind: "budget_exceeded",
    source: "budget",
    message: `Run cost $${cost.toFixed(4)} exceeded per-run budget $${cap.toFixed(2)} for team ${label}.`,
  };
  const warnings = safeParseJson(row.warnings_json, []);
  const diagnostics = safeParseJson(row.diagnostics_json, {});
  warnings.push(warning);
  db.prepare(`
    UPDATE task_runs
    SET cost_usd = COALESCE(cost_usd, ?),
        warnings_json = ?,
        diagnostics_json = ?
    WHERE id = ?
  `).run(
    cost,
    JSON.stringify(warnings),
    JSON.stringify({
      ...(diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics) ? diagnostics : {}),
      per_run_budget_exceeded: true,
      per_run_budget_usd: cap,
      per_run_budget_scope: "team",
      per_run_budget_team_id: teamId,
      cost_usd: cost,
    }),
    runId,
  );
}
