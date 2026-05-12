// Lead-cycle runner. Executes a team lead's reasoning pass against a
// synthetic root task and returns a worklab.lead_cycle.v1 result. The
// runner is invoked when task_runs.kind = 'lead_cycle'; the watcher's
// handleLeadCycleExit converts the structured output into existing
// side-effects (task assignments + createDelegatedSubtasks + system comments).

import { generateResponse, resolveModel } from "../core/index.js";
import { loadTaskRunSetup } from "../core/run-input.js";
import { getTeamById, getTeamRosterAgentNames, listTeamMembers, listRecentLeadCycles } from "../core/db/queries/teams.js";
import { getProjectById } from "../core/db/queries/projects.js";
import { getAgentByName } from "../core/db/queries/agents.js";
import { readSettings } from "../core/settings.js";
import {
  WORKLAB_LEAD_CYCLE_JSON_SCHEMA,
  normalizeLeadCycleResult,
  parseLeadCycleResultFromText,
  validateLeadCycleSemantics,
} from "../core/worklab-result/lead-cycle-contract.js";
import { createSdkEventCoalescer } from "./event-coalescer.js";
import { maxTurnsForModel } from "./util.js";

function listOpenChildTasks(db, rootTaskId) {
  return db.prepare(`
    SELECT t.id, t.task_key, t.title, t.stage, t.owner_agent, t.failure_count,
           t.last_failure_kind, t.updated_at
    FROM tasks t
    JOIN task_edges e ON e.child_task_id = t.id AND e.parent_task_id = ?
      AND e.edge_type = 'subtask'
    ORDER BY t.updated_at DESC
    LIMIT 30
  `).all(rootTaskId);
}

function listUnassignedTeamTasks(db, { teamId, projectId }) {
  return db.prepare(`
    SELECT id, task_key, title, stage, instructions, updated_at
    FROM tasks
    WHERE COALESCE(is_team_root, 0) = 0
      AND project_id = ?
      AND (team_id = ? OR team_id IS NULL)
      AND COALESCE(owner_agent, '') = ''
      AND COALESCE(stage, 'plan') NOT IN ('done', 'blocked')
    ORDER BY updated_at DESC
    LIMIT 30
  `).all(projectId, teamId);
}

function listSameProjectTasks(db, { rootTaskId, teamId, projectId }) {
  return db.prepare(`
    SELECT t.id, t.task_key, t.title, t.stage, t.owner_agent, t.updated_at,
           (
             SELECT r.summary
             FROM task_runs r
             WHERE r.task_id = t.id
             ORDER BY COALESCE(r.ended_at, r.started_at) DESC
             LIMIT 1
           ) AS last_run_summary
    FROM tasks t
    WHERE COALESCE(t.is_team_root, 0) = 0
      AND t.project_id = ?
      AND (t.team_id = ? OR t.team_id IS NULL)
      AND t.id <> ?
    ORDER BY
      CASE COALESCE(t.stage, 'plan')
        WHEN 'execute' THEN 0
        WHEN 'plan' THEN 1
        WHEN 'review' THEN 2
        WHEN 'blocked' THEN 3
        WHEN 'done' THEN 4
        ELSE 5
      END,
      t.updated_at DESC
    LIMIT 50
  `).all(projectId, teamId, rootTaskId);
}

function listDeletableLeadCreatedTasks(db, rootTaskId) {
  return db.prepare(`
    SELECT t.id, t.task_key, t.title, t.stage, t.owner_agent, t.updated_at
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    JOIN task_runs r ON r.id = e.created_by_run_id
    WHERE e.parent_task_id = ?
      AND e.edge_type = 'subtask'
      AND r.kind = 'lead_cycle'
      AND r.task_id = ?
      AND COALESCE(t.is_team_root, 0) = 0
      AND COALESCE(t.stage, 'plan') <> 'done'
      AND NOT EXISTS (
        SELECT 1
        FROM task_runs active
        WHERE active.task_id = t.id
          AND COALESCE(active.process_status, active.status, 'running') IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM task_edges child
        WHERE child.parent_task_id = t.id
          AND child.edge_type = 'subtask'
      )
    ORDER BY t.updated_at DESC
    LIMIT 30
  `).all(rootTaskId, rootTaskId);
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

function describeUnassignedTasks(tasks) {
  if (!tasks.length) return "(no unassigned team tasks)";
  return tasks.map((task) => {
    const key = task.task_key ? ` ${task.task_key}` : "";
    const instructions = String(task.instructions || "").trim();
    const summary = instructions ? ` — ${instructions.slice(0, 180)}` : "";
    return `- [${task.id}]${key} ${task.title} (stage: ${task.stage})${summary}`;
  }).join("\n");
}

function describeProjectTasks(tasks) {
  if (!tasks.length) return "(no same-project tasks outside the root roster)";
  return tasks.map((task) => {
    const key = task.task_key ? ` ${task.task_key}` : "";
    const owner = task.owner_agent ? ` - owner: ${task.owner_agent}` : "";
    const summary = String(task.last_run_summary || "").trim();
    const summaryText = summary ? ` - latest: ${summary.slice(0, 180)}` : "";
    return `- [${task.id}]${key} ${task.title} (stage: ${task.stage})${owner}${summaryText}`;
  }).join("\n");
}

function describeDeletableTasks(tasks) {
  if (!tasks.length) return "(no safe lead-created deletion candidates)";
  return tasks.map((task) => {
    const key = task.task_key ? ` ${task.task_key}` : "";
    const owner = task.owner_agent ? ` - owner: ${task.owner_agent}` : "";
    return `- [${task.id}]${key} ${task.title} (stage: ${task.stage})${owner}`;
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

export function buildLeadSystemPrompt({
  team,
  project,
  leadAgent,
  root,
  members,
  children,
  unassignedTasks,
  projectTasks = [],
  deletableTasks = [],
  recentCycles,
  maxTaskCreations,
  nativeSubagents,
}) {
  const goalBlock = team.goal
    ? `\n## Team goal\n${team.goal}\n`
    : "\n## Team goal\n(not set — work toward broad team purpose)\n";
  const goalStatusBlock = root.goal_status
    ? `\n## Current goal status\n${root.goal_status}${root.goal_status_reason ? ` — ${root.goal_status_reason}` : ""}\n`
    : "\n## Current goal status\nin_progress\n";
  return [
    `You are the team lead for "${team.name}" working on project "${project.name}".`,
    `Your role is to reason about the team's progress toward its goal and produce a structured lead-cycle decision.`,
    `You DO NOT execute tasks yourself by default; team members do. You coordinate by assigning unowned tasks, creating new tasks for roster members, and observing existing tasks.`,
    `You may assign owner_agent for tasks in the unassigned queue below. You CANNOT change task state or reassign tasks that already have an owner.`,
    "",
    `## Team roster (the only agents you may target via suggested_agent)`,
    describeMembers(members),
    leadAgent ? `(Lead: ${leadAgent.name})` : "",
    nativeSubagents?.promptMarkdown ? `## Native teammate subagents\n${nativeSubagents.promptMarkdown}` : "",
    goalBlock,
    goalStatusBlock,
    `## Open child tasks under the team root`,
    describeChildren(children),
    "",
    `## Unassigned task queue`,
    describeUnassignedTasks(unassignedTasks),
    "",
    `## Same-project owned task roster`,
    describeProjectTasks(projectTasks),
    "",
    `## Lead-created deletion candidates`,
    describeDeletableTasks(deletableTasks),
    "",
    `## Recent lead cycles (most recent first)`,
    describeRecentCycles(recentCycles),
    "",
    `## Output contract`,
    `Return a single top-level JSON object matching schema "worklab.lead_cycle.v1".`,
    `Do not wrap the lead-cycle object in worklab.v2, final_text, Markdown, prose, or any other envelope.`,
    `Required fields:`,
    `- schema: exactly "worklab.lead_cycle.v1"`,
    `- goal_status: "in_progress" | "complete" | "blocked"`,
    `- goal_status_reason: short string (required when not in_progress)`,
    `- summary: short narrative of what you decided this cycle`,
    `- checkpoint_note: compact progress note for the team-project goal dashboard`,
    `- validation_summary: what evidence, commands, or artifacts were checked this cycle (empty string if none)`,
    `- task_creations: array of { title, instructions, suggested_agent, depends_on, acceptance_criteria, expected_artifact, priority ("high"|"normal"|"low") }`,
    `- task_assignments: array of { target_task_id, owner_agent, rationale }`,
    `- task_deletions: array of { target_task_id, rationale }`,
    `- advisory_notes: array of { target_task_id, kind ("warning"|"suggestion"|"blocker_observation"), content }`,
    `- next_review_hint: { after_minutes?, after_event? } | null where after_event is only "task_completed" or "task_blocked"`,
    "",
    `Constraints:`,
    `- Every suggested_agent MUST be in the team roster above.`,
    `- Every task_assignments owner_agent MUST be in the team roster above, including yourself if you choose to own it.`,
    `- Every task_assignments target_task_id MUST be one of the unassigned tasks above.`,
    `- Every task_deletions target_task_id MUST be one of the lead-created deletion candidates above.`,
    `- Use task_deletions only for obsolete lead-created tasks that are no longer relevant.`,
    `- Do not create a task if same-project owned work already represents it.`,
    `- task_creations max ${maxTaskCreations} per cycle.`,
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
  const unassignedTasks = listUnassignedTeamTasks(db, { teamId: team.id, projectId: project.id });
  const projectTasks = listSameProjectTasks(db, { rootTaskId: root.id, teamId: team.id, projectId: project.id });
  const deletableTasks = listDeletableLeadCreatedTasks(db, root.id);
  const scopeTaskIds = children.map((c) => c.id);
  for (const task of unassignedTasks) scopeTaskIds.push(task.id);
  for (const task of projectTasks) scopeTaskIds.push(task.id);
  scopeTaskIds.push(root.id);
  const assignableTaskIds = unassignedTasks.map((task) => task.id);
  const deletableTaskIds = deletableTasks.map((task) => task.id);
  const existingTaskTitles = projectTasks.map((task) => task.title);
  const recentCycles = listRecentLeadCycles(db, team.id, 10);
  const settings = readSettings(db);
  const configuredMaxTaskCreations = Number(settings.delegation_max_children_per_round);
  const maxTaskCreations = Number.isInteger(configuredMaxTaskCreations) && configuredMaxTaskCreations > 0
    ? configuredMaxTaskCreations
    : 5;

  // Reuse the standard task-run setup so the lead has the same MCP/skill/
  // tool surface as a regular agent run. We override the system prompt
  // because the lead's job is structurally different from a task agent.
  let setup;
  try {
    setup = loadTaskRunSetup({ config, db, taskId: root.id, agentName, runId, mode: "execute" });
  } catch (err) {
    return { kind: "lead_cycle", error: err.message || String(err) };
  }
  const { agent, skills, skillDirs, mcpServers, allowedTools, disallowedTools, toolPolicy, qaOutputDir, nativeSubagents } = setup;
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));

  const systemPrompt = buildLeadSystemPrompt({
    team,
    project,
    leadAgent,
    root,
    members,
    children,
    unassignedTasks,
    projectTasks,
    deletableTasks,
    recentCycles,
    maxTaskCreations,
    nativeSubagents,
  });

  emit({ type: "prompt_built", diagnostics: { lead_cycle: true, team_id: team.id, project_id: project.id } });

  try {
    const result = await generateResponse(systemPrompt, {
      model,
      effort: agent.effort || "medium",
      executionMode: agent.execution_mode || "sdk",
      contextWindow: agent.context_window || "default",
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
      nativeSubagents,
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
    const structured = result.structuredResult;
    if (structured && typeof structured === "object" && structured.schema === "worklab.lead_cycle.v1") {
      const norm = normalizeLeadCycleResult(structured);
      if (norm.ok) parsedResult = norm.result; else parseError = norm.error;
    }
    if (!parsedResult) {
      const fromText = parseLeadCycleResultFromText(result.text || "");
      if (fromText.ok) parsedResult = fromText.result;
      else parseError = parseError || fromText.error;
    }

    let semantic = { ok: false, error: parseError || "no lead_cycle_result emitted" };
    if (parsedResult) {
      semantic = validateLeadCycleSemantics(parsedResult, {
        rosterAgents,
        scopeTaskIds,
        assignableTaskIds,
        deletableTaskIds,
        existingTaskTitles,
        maxTaskCreations,
      });
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
