// Lead-cycle runner. Executes a team lead's reasoning pass against a
// synthetic root task and returns a worklab.lead_cycle.v1 result. The
// runner is invoked when task_runs.kind = 'lead_cycle'; the watcher's
// handleLeadCycleExit converts the structured output into existing
// side-effects (createDelegatedSubtasks + system comments) — no direct
// state mutation flows from the lead.

import { generateResponse, resolveModel } from "../core/index.js";
import { loadTaskRunSetup } from "../core/run-input.js";
import { getTeamById, getTeamRosterAgentNames, listTeamMembers, listRecentLeadCycles } from "../core/db/queries/teams.js";
import { getProjectById } from "../core/db/queries/projects.js";
import { getAgentByName } from "../core/db/queries/agents.js";
import {
  WORKLAB_LEAD_CYCLE_JSON_SCHEMA,
  normalizeLeadCycleResult,
  parseLeadCycleResultFromText,
  validateLeadCycleSemantics,
} from "../ai/result/lead-cycle-contract.js";
import { createSdkEventCoalescer } from "./event-coalescer.js";
import { maxTurnsForModel } from "./util.js";

function listOpenChildTasks(db, rootTaskId) {
  return db.prepare(`
    SELECT t.id, t.task_key, t.title, t.stage, t.owner_agent, t.failure_count,
           t.last_failure_kind, t.updated_at
    FROM tasks t
    JOIN task_edges e ON e.child_task_id = t.id AND e.parent_task_id = ?
    ORDER BY t.updated_at DESC
    LIMIT 30
  `).all(rootTaskId);
}

function describeMembers(members) {
  if (!members.length) return "(no members configured)";
  return members.map((m) => {
    const role = m.role_description ? ` — ${m.role_description}` : "";
    const enabled = m.enabled === 0 ? " [disabled]" : "";
    return `- ${m.agent_name} (${m.display_name || m.agent_name})${role}${enabled}`;
  }).join("\n");
}

function describeChildren(children) {
  if (!children.length) return "(no child tasks under this root yet)";
  return children.map((c) => {
    const owner = c.owner_agent ? ` — owner: ${c.owner_agent}` : "";
    const failures = c.failure_count ? ` — failures: ${c.failure_count}` : "";
    const failureKind = c.last_failure_kind ? ` — last_failure: ${c.last_failure_kind}` : "";
    return `- [${c.id}] ${c.task_key || ""} ${c.title} (stage: ${c.stage})${owner}${failures}${failureKind}`;
  }).join("\n");
}

function describeRecentCycles(cycles) {
  if (!cycles.length) return "(no prior cycles)";
  return cycles.slice(0, 8).map((r) => {
    const status = r.process_status || r.status;
    const cost = r.cost_usd ? ` ($${Number(r.cost_usd).toFixed(4)})` : "";
    const summary = r.summary ? ` — ${r.summary.slice(0, 200)}` : "";
    return `- ${new Date(r.started_at).toISOString()} ${status}${cost}${summary}`;
  }).join("\n");
}

function buildLeadSystemPrompt({ team, project, leadAgent, root, members, children, recentCycles }) {
  const goalBlock = team.goal
    ? `\n## Team goal\n${team.goal}\n`
    : "\n## Team goal\n(not set — work toward broad team purpose)\n";
  const goalStatusBlock = root.goal_status
    ? `\n## Current goal status\n${root.goal_status}${root.goal_status_reason ? ` — ${root.goal_status_reason}` : ""}\n`
    : "\n## Current goal status\nin_progress\n";
  return [
    `You are the team lead for "${team.name}" working on project "${project.name}".`,
    `Your role is to reason about the team's progress toward its goal and produce a structured lead-cycle decision.`,
    `You DO NOT execute tasks yourself; team members do. You coordinate by creating new tasks for them and observing existing tasks.`,
    `You CANNOT reassign existing tasks or change their state. You can only create new tasks (assigned to roster members) and post advisory notes on existing tasks in this team's scope.`,
    "",
    `## Team roster (the only agents you may target via suggested_agent)`,
    describeMembers(members),
    leadAgent ? `(Lead: ${leadAgent.name})` : "",
    goalBlock,
    goalStatusBlock,
    `## Open child tasks under the team root`,
    describeChildren(children),
    "",
    `## Recent lead cycles (most recent first)`,
    describeRecentCycles(recentCycles),
    "",
    `## Output contract`,
    `Return a single JSON object matching schema "worklab.lead_cycle.v1" with fields:`,
    `- goal_status: "in_progress" | "complete" | "blocked"`,
    `- goal_status_reason: short string (required when not in_progress)`,
    `- summary: short narrative of what you decided this cycle`,
    `- task_creations: array of { title, instructions, suggested_agent, depends_on, acceptance_criteria, expected_artifact, priority }`,
    `- advisory_notes: array of { target_task_id, kind ("warning"|"suggestion"|"blocker_observation"), content }`,
    `- next_review_hint: { after_minutes?, after_event? } | null`,
    "",
    `Constraints:`,
    `- Every suggested_agent MUST be in the team roster above.`,
    `- task_creations max 8 per cycle.`,
    `- If goal_status="complete", task_creations MUST be empty.`,
    `- advisory_notes target_task_id must be one of the open child tasks above (or another task currently scoped to this team).`,
  ].filter(Boolean).join("\n");
}

export async function runLeadCycle(ctx) {
  const { db, config, ac, emit, agentName, runId, taskId } = ctx;

  const root = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!root || !root.is_team_root) {
    return { kind: "lead_cycle", error: "lead-cycle runner invoked on non-team-root task" };
  }
  if (!root.team_id || !root.project_id) {
    return { kind: "lead_cycle", error: "team root task missing team_id or project_id" };
  }
  const team = getTeamById(db, root.team_id);
  const project = getProjectById(db, root.project_id);
  if (!team || !project) {
    return { kind: "lead_cycle", error: "team or project not found" };
  }
  const leadAgent = getAgentByName(db, agentName);
  if (!leadAgent || !leadAgent.enabled) {
    return { kind: "lead_cycle", error: `lead agent ${agentName} not enabled` };
  }

  const members = listTeamMembers(db, team.id);
  const rosterAgents = getTeamRosterAgentNames(db, team.id);
  const children = listOpenChildTasks(db, root.id);
  const scopeTaskIds = children.map((c) => c.id);
  scopeTaskIds.push(root.id);
  const recentCycles = listRecentLeadCycles(db, team.id, 10);

  // Reuse the standard task-run setup so the lead has the same MCP/skill/
  // tool surface as a regular agent run. We override the system prompt
  // because the lead's job is structurally different from a task agent.
  let setup;
  try {
    setup = loadTaskRunSetup({ config, db, taskId: root.id, agentName, runId, mode: "execute" });
  } catch (err) {
    return { kind: "lead_cycle", error: err.message || String(err) };
  }
  const { agent, skills, skillDirs, mcpServers, allowedTools, disallowedTools, toolPolicy, qaOutputDir } = setup;
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));

  const systemPrompt = buildLeadSystemPrompt({
    team,
    project,
    leadAgent,
    root,
    members,
    children,
    recentCycles,
  });

  emit({ type: "prompt_built", diagnostics: { lead_cycle: true, team_id: team.id, project_id: project.id } });

  try {
    const result = await generateResponse(systemPrompt, {
      model,
      effort: agent.effort || "medium",
      executionMode: agent.execution_mode || "sdk",
      db,
      dataDir: config.dataDir,
      skills,
      skillDirs,
      messages: [{
        role: "user",
        content: `Run a lead cycle now. Inspect the open child tasks and recent activity, then emit a worklab.lead_cycle.v1 result.`,
      }],
      cwd: config.workspace,
      mcpServers,
      allowedTools,
      disallowedTools,
      toolPolicy,
      permissionMode: "bypassPermissions",
      maxTurns: maxTurnsForModel(model, 16),
      outputSchema: WORKLAB_LEAD_CYCLE_JSON_SCHEMA,
      runArtifactDir: qaOutputDir,
      abortSignal: ac.signal,
      onEvent: sdkEvents.emit,
    });
    if (result.cancelled) {
      return { kind: "lead_cycle", cancelled: true, providerSessionId: result.providerSessionId || null };
    }
    if (result.error) {
      return {
        kind: "lead_cycle",
        error: result.error,
        failureKind: result.failureKind,
        errorDetails: result.errorDetails || null,
        providerSessionId: result.providerSessionId || null,
        runtimeWarnings: result.runtimeWarnings,
      };
    }

    let parsedResult = null;
    let parseError = null;
    if (result.worklabResult && result.worklabResult.schema === "worklab.lead_cycle.v1") {
      const norm = normalizeLeadCycleResult(result.worklabResult);
      if (norm.ok) parsedResult = norm.result; else parseError = norm.error;
    }
    if (!parsedResult) {
      const fromText = parseLeadCycleResultFromText(result.text || "");
      if (fromText.ok) parsedResult = fromText.result;
      else parseError = parseError || fromText.error;
    }

    let semantic = { ok: false, error: parseError || "no lead_cycle_result emitted" };
    if (parsedResult) {
      semantic = validateLeadCycleSemantics(parsedResult, { rosterAgents, scopeTaskIds });
    }

    return {
      kind: "lead_cycle",
      text: result.text,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      providerSessionId: result.providerSessionId || null,
      runtimeWarnings: result.runtimeWarnings,
      leadCycleResult: parsedResult,
      parsedResultError: semantic.ok ? null : semantic.error,
      parsedResultFatal: !semantic.ok,
      parsedResultWarningKind: semantic.ok ? null : "lead_cycle_result_validation",
    };
  } catch (err) {
    return { kind: "lead_cycle", error: err.message || String(err) };
  } finally {
    sdkEvents.flush();
  }
}
