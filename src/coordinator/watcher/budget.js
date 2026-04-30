import {
  getAgentBudget,
  getAgentPerRunBudget,
} from "../../core/db/queries/agents.js";
import { getRunWarningsAndDiagnostics } from "../../core/db/queries/runs.js";
import { readSettings } from "../../core/settings.js";
import { safeParseJson } from "./run-handler.js";

export function checkBudget({ db, agentName }) {
  const settings = readSettings(db);
  const agent = getAgentBudget(db, agentName);
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const since = startOfDayUtc.getTime();
  const todayCostRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM task_runs
    WHERE agent_name = ? AND started_at >= ? AND cost_usd IS NOT NULL
  `).get(agentName, since);
  const workspaceCostRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM task_runs
    WHERE started_at >= ? AND cost_usd IS NOT NULL
  `).get(since);
  const agentSpend = Number(todayCostRow?.total || 0);
  const workspaceSpend = Number(workspaceCostRow?.total || 0);
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
  const agentDailyBudget = Number(agent?.daily_budget_usd || 0);
  if (agentDailyBudget > 0 && agentSpend >= agentDailyBudget) {
    return {
      ok: false,
      scope: "agent_daily",
      spent: agentSpend,
      cap: agentDailyBudget,
      message: `Daily budget for ${agentName} reached ($${agentSpend.toFixed(4)} of $${agentDailyBudget.toFixed(2)}).`,
    };
  }
  return { ok: true, agentSpend, workspaceSpend };
}

export function recordPerRunBudgetOverage({ db, runId, agentName, costUsd }) {
  const cost = Number(costUsd);
  if (!Number.isFinite(cost)) return;
  const agent = getAgentPerRunBudget(db, agentName);
  const cap = Number(agent?.per_run_budget_usd || 0);
  if (!(cap > 0) || cost <= cap) {
    db.prepare("UPDATE task_runs SET cost_usd = COALESCE(cost_usd, ?) WHERE id = ?").run(cost, runId);
    return;
  }

  const row = getRunWarningsAndDiagnostics(db, runId);
  if (!row) return;
  const warning = {
    kind: "budget_exceeded",
    source: "budget",
    message: `Run cost $${cost.toFixed(4)} exceeded per-run budget $${cap.toFixed(2)} for ${agentName}.`,
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
      cost_usd: cost,
    }),
    runId,
  );
}
