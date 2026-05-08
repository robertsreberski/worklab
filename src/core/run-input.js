import { join } from "node:path";
import { loadSkills } from "./skills.js";
import { enrichCommentRows } from "./comments.js";
import { getAvailableMcpServers } from "./mcp-config.js";
import { readAgentMemoryContext } from "./memory.js";
import { buildSystemPrompt } from "./prompts/system-prompt.js";
import { WORKLAB_BUILTIN_TOOLS, resolveModel } from "./ai.js";
import { extractExecutionFromEvents } from "./review-exec.js";
import { kbListPinned } from "./kb.js";
import { parseStoredAllowlist, resolveAllowlist, resolveAllowlistMap, storedAllowlistMode } from "@worklab/agent-runtime/agent/allowlists.js";
import { readSettings } from "./settings.js";
import { applyPlanningToolPolicy } from "./planning-harness.js";
import { nextStage } from "./state-machine.js";
import { taskStage } from "./task-side-effects.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "./task-agents.js";
import { applyBrowserToolsReviewOnlyPolicy } from "./browser-tool-policy.js";
import { getProcessContextCache, makeContextCacheKey, shortHash } from "./context-cache.js";
import { findRepositoryGitRoot, loadRepositoryInstructions } from "./repository-instructions.js";
import { formatAgentLearningContext, selectAgentLearningMemories } from "./agent-learning.js";
import { getTaskById } from "./db/queries/tasks.js";
import { getLatestExecuteRunSummary, getRunById } from "./db/queries/runs.js";
import { getAgentByName } from "./db/queries/agents.js";
import { listTaskComments } from "./db/queries/comments.js";
import { getAgentLogByRunId } from "./db/queries/agent-logs.js";
import { loadRunSnapshot, resolveTaskProjectRunContext } from "./projects.js";
import { resolveRunArtifactDir } from "./run-artifact-paths.js";
import { formatTaskArtifactsForPrompt, loadTaskArtifacts } from "./run-artifacts.js";
import { buildDelegationContext } from "./delegation.js";
import { buildNativeSubagentContext } from "./native-subagents.js";
import { formatWorklabResultText } from "./worklab-result/contract.js";
import { renderResumeSnapshot } from "@worklab/agent-runtime/agent/transcript.js";

function runInputError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function requireDataDir(config) {
  if (!config?.dataDir) {
    throw runInputError(501, "not_configured", "run input preview requires a configured data directory");
  }
}

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function renderWorktreeConflictRetryContext(diagnostics = {}) {
  if (!diagnostics?.worktree_conflict_retry) return "";
  const conflictPaths = Array.isArray(diagnostics.conflict_paths) ? diagnostics.conflict_paths : [];
  const lines = [
    "### Worktree conflict retry",
    diagnostics.worktree_conflict_retry_of_run_id ? `Previous run: \`${diagnostics.worktree_conflict_retry_of_run_id}\`` : "",
    diagnostics.previous_branch ? `Previous AI branch: \`${diagnostics.previous_branch}\`` : "",
    diagnostics.previous_branch_head ? `Previous branch head: ${String(diagnostics.previous_branch_head).slice(0, 7)}` : "",
    diagnostics.source_head ? `Source head: ${String(diagnostics.source_head).slice(0, 7)}` : "",
    conflictPaths.length ? `Conflict paths: ${conflictPaths.map((path) => `\`${path}\``).join(", ")}` : "",
    diagnostics.guidance || "",
  ].filter(Boolean);
  return lines.join("\n");
}

export function modeForTaskStage(stage) {
  if (stage === "plan") return "plan";
  if (stage === "review") return "review";
  if (stage === "execute") return "execute";
  return null;
}

export function hasOpenBlocker(db, taskId) {
  return db.prepare(`
    SELECT t.id, t.title
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ? AND COALESCE(t.stage, 'plan') <> 'done'
    ORDER BY t.updated_at DESC
    LIMIT 1
  `).get(taskId);
}

export function latestPriorExecuteRunId(db, taskId) {
  return db.prepare(`
    SELECT id
    FROM task_runs
    WHERE task_id = ?
      AND mode = 'execute'
    ORDER BY ended_at DESC, started_at DESC, rowid DESC
    LIMIT 1
  `).get(taskId)?.id || null;
}

export function assertAgentRunnable(db, agentName) {
  const agent = getAgentByName(db, agentName);
  if (!agent) throw runInputError(400, "invalid_state", `agent not found: ${agentName}`);
  if (!agent.enabled) throw runInputError(400, "invalid_state", `agent disabled: ${agentName}`);
  try {
    return { agent, providerKind: resolveModel(agent.model).sdk };
  } catch (err) {
    throw runInputError(400, "invalid_state", `invalid agent model for ${agentName}: ${err.message}`);
  }
}

function runtimeDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function isoDateFromParts(parts) {
  if (!parts?.year || !parts?.month || !parts?.day) return "";
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToIsoDate(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function detectedRuntimeTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function buildRuntimeDateContext({ now = Date.now(), timezone } = {}) {
  const runDate = now instanceof Date
    ? now
    : (typeof now === "number" ? new Date(now) : new Date(Number.isFinite(Number(now)) ? Number(now) : now));
  const safeDate = Number.isFinite(runDate.getTime()) ? runDate : new Date();
  const timeZone = timezone || detectedRuntimeTimezone();
  let parts;
  let resolvedTimeZone = timeZone;
  try {
    parts = runtimeDateParts(safeDate, timeZone);
  } catch {
    resolvedTimeZone = "UTC";
    parts = runtimeDateParts(safeDate, resolvedTimeZone);
  }
  const today = isoDateFromParts(parts);
  const time = [parts.hour, parts.minute, parts.second].filter(Boolean).join(":");
  return {
    runStartedAt: safeDate.toISOString(),
    timezone: parts.timeZoneName ? `${resolvedTimeZone} (${parts.timeZoneName})` : resolvedTimeZone,
    localTime: [parts.weekday, today, time].filter(Boolean).join(", ").replace(/, ([0-9:]+)$/, " $1"),
    today,
    yesterday: addDaysToIsoDate(today, -1),
  };
}

function formatRuntimeDateContext(context) {
  if (!context?.runStartedAt) return "";
  return [
    "## Runtime context",
    "",
    `Run started: ${context.runStartedAt}`,
    `Timezone: ${context.timezone}`,
    `Local time: ${context.localTime}`,
    `Today: ${context.today}`,
    `Yesterday: ${context.yesterday}`,
    "",
    "Prior run and journal dates are historical context, not the current date. Resolve relative dates like today, yesterday, and previous calendar day from this runtime context unless the active task explicitly names a different target date.",
  ].join("\n");
}

function joinMessageParts(parts) {
  return parts.filter((part) => part !== null && part !== undefined).join("\n");
}

export function buildTaskRunMessages({ mode, task, runtimeDateContext = null }) {
  const runtimeBlock = formatRuntimeDateContext(runtimeDateContext);
  if (mode === "review") {
    return [{
      role: "user",
      content: joinMessageParts([
        "# Review task",
        "",
        runtimeBlock || null,
        runtimeBlock ? "" : null,
        `Task: "${task.title}"`,
        "",
        "Review this task against the instructions and respond with your verdict.",
      ]),
    }];
  }
  if (mode === "plan") {
    return [{
      role: "user",
      content: joinMessageParts([
        "# Plan task",
        "",
        runtimeBlock || null,
        runtimeBlock ? "" : null,
        `Task: "${task.title}"`,
        "",
        "Plan this task. Clarify the work, identify risks, and decide whether to proceed directly or delegate bounded subtasks. Ask only the critical human questions needed before a useful plan can be written.",
      ]),
    }];
  }
  return [{
    role: "user",
    content: joinMessageParts([
      "# Work on task",
      "",
      runtimeBlock || null,
      runtimeBlock ? "" : null,
      `Task: "${task.title}"`,
      "",
      "Do the task work requested by the instructions.",
    ]),
  }];
}

export function loadAgentCapabilities({ config, agent, agentName, runId, env, mode = null }) {
  requireDataDir(config);
  const availableSkills = loadSkills(join(config.dataDir, "skills")).filter((skill) => skill.enabled !== false);
  let skills = resolveAllowlist({
    mode: agent.skills_allowlist_mode,
    allowlist: parseStoredAllowlist(agent.skills_allowlist),
    all: availableSkills,
    getName: (skill) => skill.name,
  });

  const allMcpServers = getAvailableMcpServers(config.dataDir, { repoRoot: config.repoRoot });
  let mcpServers = resolveAllowlistMap({
    mode: agent.mcp_allowlist_mode,
    allowlist: parseStoredAllowlist(agent.mcp_allowlist),
    all: allMcpServers,
  });

  const browserPolicy = applyBrowserToolsReviewOnlyPolicy({ agent, mode, skills, mcpServers });
  skills = browserPolicy.skills;
  mcpServers = browserPolicy.mcpServers;

  const baseMcpEnv = {
    WORKLAB_RUN_ID: runId,
    ...(env || {}),
  };
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server?.command) continue;
    mcpServers[name] = {
      ...server,
      env: {
        ...(server.env || {}),
        ...baseMcpEnv,
        ...(name === "worklab" ? {
          WORKLAB_DATA_DIR: config.dataDir,
          WORKLAB_AGENT_NAME: agentName,
        } : {}),
      },
    };
  }

  const builtinMode = storedAllowlistMode(agent.builtin_allowlist_mode);
  const allowedTools = builtinMode === "all"
    ? [...WORKLAB_BUILTIN_TOOLS]
    : parseStoredAllowlist(agent.builtin_allowlist).filter((tool) => WORKLAB_BUILTIN_TOOLS.includes(tool));
  const disallowedTools = builtinMode === "custom" && allowedTools.length === 0
    ? [...WORKLAB_BUILTIN_TOOLS]
    : [];

  return {
    skills,
    mcpServers,
    allowedTools,
    disallowedTools,
    skillDirs: browserPolicy.skillDirs,
    capabilityRestrictions: browserPolicy.capabilityRestrictions,
  };
}

export function loadTaskRunSetup({ config, db, taskId, agentName, runId, mode = null }) {
  requireDataDir(config);
  const task = getTaskById(db, taskId);
  if (!task) throw runInputError(404, "not_found", `task ${taskId} not found`);
  const agent = getAgentByName(db, agentName);
  if (!agent) throw runInputError(400, "invalid_state", `agent ${agentName} not found`);
  const settings = readSettings(db);
  const runSnapshot = loadRunSnapshot(db, runId);
  const runDiagnostics = safeParseJson(runSnapshot?.diagnostics_json, {});
  const workspaceMode = runSnapshot?.workspace_mode || "direct";
  const sourceWorkdir = runSnapshot?.source_workdir || null;
  const worktree = safeParseJson(runSnapshot?.worktree_json, null);
  const resumeContext = [
    renderResumeSnapshot(runDiagnostics?.resume_snapshot),
    renderWorktreeConflictRetryContext(runDiagnostics),
  ].filter(Boolean).join("\n\n");
  const projectRunContext = resolveTaskProjectRunContext({ db, config, task, runSnapshot });
  const repositoryInstructions = loadRepositoryInstructions(projectRunContext.effectiveWorkdir);
  const repositoryGitRoot = findRepositoryGitRoot(projectRunContext.effectiveWorkdir);
  const qaOutputDir = resolveRunArtifactDir({
    workdir: projectRunContext.effectiveWorkdir,
    runId,
  });
  if (runSnapshot && projectRunContext.projectContextHash
    && runSnapshot.project_context_hash
    && runSnapshot.project_context_hash !== projectRunContext.projectContextHash) {
    db.prepare("UPDATE task_runs SET project_context_hash = ? WHERE id = ?")
      .run(projectRunContext.projectContextHash, runId);
  }

  const commentRows = enrichCommentRows(
    db,
    listTaskComments(db, taskId),
  );

  const { memory, journalTail } = readAgentMemoryContext({
    dataDir: config.dataDir,
    agent: agentName,
    maxJournalLines: settings.journal_tail_lines,
  });
  const learningMemories = settings.agent_learning_enabled !== false
    ? selectAgentLearningMemories(db, {
      agentName,
      projectId: projectRunContext.project?.id || task.project_id || null,
      taskId,
      limit: settings.agent_learning_injected_limit,
    })
    : [];
  const learningMemoryContext = formatAgentLearningContext(learningMemories);
  const runEnv = {
    WORKLAB_TASK_ID: taskId,
    WORKLAB_TASK_TITLE: task.title,
    WORKLAB_WORKSPACE: projectRunContext.effectiveWorkdir,
    ...(qaOutputDir ? {
      WORKLAB_QA_OUTPUT_DIR: qaOutputDir,
      PLAYWRIGHT_MCP_OUTPUT_DIR: qaOutputDir,
    } : {}),
    ...(projectRunContext.project ? {
      WORKLAB_PROJECT_ID: projectRunContext.project.id,
      WORKLAB_PROJECT_SLUG: projectRunContext.project.slug,
      WORKLAB_PROJECT_NAME: projectRunContext.project.name,
    } : {}),
  };
  const { skills, mcpServers, allowedTools, disallowedTools, skillDirs, capabilityRestrictions } = loadAgentCapabilities({
    config,
    agent,
    agentName,
    runId,
    mode,
    env: runEnv,
  });

  const pinnedKb = kbListPinned({ dataDir: config.dataDir, limit: settings.kb_pinned_limit });
  const delegation = buildDelegationContext({ db, task, settings });
  const nativeSubagents = buildNativeSubagentContext({
    db,
    config,
    task,
    parentAgent: agent,
    agentName,
    runId,
    mode,
    settings,
    env: runEnv,
    loadCapabilities: loadAgentCapabilities,
  });

  return {
    task,
    agent,
    project: projectRunContext.project,
    effectiveWorkdir: projectRunContext.effectiveWorkdir,
    workspaceMode,
    sourceWorkdir,
    worktree,
    repositoryInstructions,
    repositoryGitRoot,
    qaOutputDir,
    resumeContext,
    projectContextHash: projectRunContext.projectContextHash,
    commentRows,
    skills,
    skillDirs,
    memory,
    learningMemories,
    learningMemoryContext,
    journalTail,
    mcpServers,
    allowedTools,
    disallowedTools,
    capabilityRestrictions,
    pinnedKb,
    settings,
    delegation,
    nativeSubagents,
    runStartedAt: runSnapshot?.started_at || null,
  };
}

export function loadPriorRunSummaries(db, taskId, currentRunId, limit = 4) {
  const runs = db.prepare(
    `SELECT * FROM task_runs
      WHERE task_id = ? AND id != ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT ?`,
  ).all(taskId, currentRunId, limit);

  return runs.map((run) => {
    const logRow = getAgentLogByRunId(db, run.id);
    const priorEvents = logRow ? parseEvents(logRow.events) : [];
    const execution = extractExecutionFromEvents(priorEvents, run);
    const diagnostics = safeParseJson(run.diagnostics_json, {});
    const diagnosticWorktree = diagnostics?.worktree && typeof diagnostics.worktree === "object"
      ? diagnostics.worktree
      : {};
    const parsedWorktree = safeParseJson(run.worktree_json, {});
    const worktree = parsedWorktree && typeof parsedWorktree === "object"
      ? parsedWorktree
      : {};
    const retry = diagnostics?.worktree_conflict_retry && typeof diagnostics.worktree_conflict_retry === "object"
      ? diagnostics.worktree_conflict_retry
      : {};
    const worktreeSummary = (() => {
      const status = diagnosticWorktree.status
        || worktree.last_reconcile_status
        || worktree.status
        || null;
      const branch = diagnosticWorktree.branch || worktree.branch || null;
      const conflictPaths = diagnosticWorktree.conflict_paths || worktree.conflict_paths || [];
      if (!status && !branch && !conflictPaths.length) return null;
      return {
        status,
        branch,
        branchHead: diagnosticWorktree.branch_head || worktree.branch_head || null,
        sourceHead: diagnosticWorktree.source_head
          || diagnosticWorktree.source_head_before
          || worktree.source_head
          || null,
        conflictPaths,
        retryRunId: retry.retry_run_id || null,
      };
    })();
    return {
      id: run.id,
      mode: run.mode,
      status: run.status,
      agentName: run.agent_name ?? "unknown",
      startedAt: run.started_at ?? null,
      endedAt: run.ended_at ?? null,
      errorText: run.error_text ?? null,
      finalText: execution.finalText,
      numTurns: execution.numTurns,
      durationMs: execution.durationMs,
      worktree: worktreeSummary,
    };
  });
}

function executionOutputForRun(run, events = []) {
  if (!run) return "";
  const execution = extractExecutionFromEvents(events, run);
  if (execution.finalText) return execution.finalText;
  const resultText = formatWorklabResultText(safeParseJson(run.result_json, null));
  if (resultText) return resultText;
  if (run.summary && run.details && run.summary !== run.details) return `${run.summary}\n\n${run.details}`;
  return run.details || run.summary || run.error_text || "";
}

export function loadResolvedBlockerContext(db, taskId, { limit = 8 } = {}) {
  if (!db || !taskId) return [];
  const blockers = db.prepare(`
    SELECT t.id, t.task_key, t.title, t.stage, t.stage_reason,
           t.owner_agent, t.reviewer_agent, t.completed_at, t.updated_at
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
      AND COALESCE(t.stage, 'plan') = 'done'
    ORDER BY t.updated_at DESC, t.rowid DESC
    LIMIT ?
  `).all(taskId, limit);

  return blockers.map((blocker) => {
    const latestExecute = getLatestExecuteRunSummary(db, blocker.id);
    const logRow = latestExecute ? getAgentLogByRunId(db, latestExecute.id) : null;
    const events = logRow ? parseEvents(logRow.events) : [];
    const taskArtifacts = loadTaskArtifacts(db, blocker.id);
    return {
      id: blocker.id,
      task_key: blocker.task_key || null,
      title: blocker.title,
      stage: blocker.stage || "plan",
      stage_reason: blocker.stage_reason || null,
      owner_agent: blocker.owner_agent || null,
      reviewer_agent: blocker.reviewer_agent || null,
      completed_at: blocker.completed_at || null,
      updated_at: blocker.updated_at || null,
      latest_execute_run: latestExecute ? {
        id: latestExecute.id,
        mode: latestExecute.mode,
        stage: latestExecute.stage,
        agentName: latestExecute.agent_name ?? "unknown",
        status: latestExecute.status,
        process_status: latestExecute.process_status || latestExecute.status || null,
        decision: latestExecute.decision || null,
        failure_kind: latestExecute.failure_kind || null,
        summary: latestExecute.summary || null,
        details: latestExecute.details || null,
        finalText: executionOutputForRun(latestExecute, events),
        startedAt: latestExecute.started_at ?? null,
        endedAt: latestExecute.ended_at ?? null,
        artifact_summary: safeParseJson(latestExecute.artifact_summary_json, {}),
      } : null,
      artifacts: taskArtifacts.artifacts,
      artifact_summary: taskArtifacts.summary,
    };
  });
}

export function selectCurrentRunComments(db, taskId, currentRunId, comments = []) {
  const currentRun = db.prepare(
    "SELECT started_at FROM task_runs WHERE id = ? AND task_id = ?",
  ).get(currentRunId, taskId);
  if (!currentRun?.started_at) return [];

  const previousRun = db.prepare(
    `SELECT started_at, ended_at
      FROM task_runs
      WHERE task_id = ?
        AND id != ?
        AND started_at <= ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1`,
  ).get(taskId, currentRunId, currentRun.started_at);

  const boundary = Number(previousRun?.ended_at ?? previousRun?.started_at ?? 0);
  const currentStartedAt = Number(currentRun.started_at);
  return (comments || []).filter((comment) => {
    const authorType = comment?.author_type || comment?.author?.type;
    const createdAt = Number(comment?.created_at);
    return authorType === "human"
      && Number.isFinite(createdAt)
      && createdAt > boundary
      && createdAt <= currentStartedAt;
  });
}

function diagnosticsForPrompt(prompt, setup) {
  const { skills = [], allowedTools = [], mcpServers = {}, disallowedTools = [] } = setup;
  return {
    prefixHash: prompt.prefixHash,
    promptChars: prompt.text.length,
    project: setup.project ? {
      id: setup.project.id,
      slug: setup.project.slug,
      contextHash: setup.projectContextHash,
      workdir: setup.effectiveWorkdir,
      workspaceMode: setup.workspaceMode || "direct",
      sourceWorkdir: setup.sourceWorkdir || null,
    } : null,
    repositoryInstructions: setup.repositoryInstructions ? {
      path: setup.repositoryInstructions.path,
      hash: setup.repositoryInstructions.hash,
      truncated: !!setup.repositoryInstructions.truncated,
    } : null,
    repositoryGitRoot: setup.repositoryGitRoot || null,
    workspaceMode: setup.workspaceMode || "direct",
    sourceWorkdir: setup.sourceWorkdir || null,
    worktree: setup.worktree ? {
      branch: setup.worktree.branch || null,
      status: setup.worktree.status || null,
      runtime_workdir: setup.worktree.runtime_workdir || null,
    } : null,
    toolCount: {
      skills: Array.isArray(skills) ? skills.length : 0,
      builtin: Array.isArray(allowedTools) ? allowedTools.filter((tool) => !disallowedTools.includes(tool)).length : 0,
      mcp: Object.keys(mcpServers || {}).length,
    },
    artifacts: setup.taskArtifacts?.summary || null,
    resolvedBlockers: Array.isArray(setup.resolvedBlockers) ? setup.resolvedBlockers.length : 0,
    learningMemories: Array.isArray(setup.learningMemories) ? setup.learningMemories.length : 0,
    resumeContext: !!setup.resumeContext,
    planning: setup.planningDiagnostics || null,
    nativeSubagents: setup.nativeSubagents ? {
      provider: setup.nativeSubagents.provider,
      mode: setup.nativeSubagents.mode,
      teamId: setup.nativeSubagents.teamId,
      count: setup.nativeSubagents.teammates?.length || 0,
    } : null,
  };
}

function makeSetupSignature(setup, { mode, priorRunId } = {}) {
  const skillsSignature = (setup.skills || []).map((skill) => `${skill.name}:${skill.priority || ""}:${skill.enabled ? "1" : "0"}`);
  const mcpSignature = Object.keys(setup.mcpServers || {});
  const builtinSignature = setup.allowedTools || [];
  const pinnedSignature = (setup.pinnedKb || []).map((entry) => `${entry.slug || entry.title || ""}:${entry.updatedAt || entry.updated_at || ""}`);
  const artifactSignature = (setup.taskArtifacts?.artifacts || [])
    .map((artifact) => [
      artifact.path,
      artifact.added_lines || 0,
      artifact.removed_lines || 0,
      artifact.last_run_id || "",
      artifact.last_seen_at || "",
    ].join(":"));
  const blockerSignature = (setup.resolvedBlockers || []).map((blocker) => {
    const latest = blocker.latest_execute_run || {};
    const summary = blocker.artifact_summary || {};
    return [
      blocker.id,
      blocker.stage,
      blocker.updated_at || "",
      latest.id || "",
      latest.status || "",
      latest.process_status || "",
      latest.decision || "",
      latest.summary || "",
      latest.finalText || "",
      summary.files || 0,
      summary.added_lines || 0,
      summary.removed_lines || 0,
      summary.run_count || 0,
    ].join(":");
  });
  const delegation = setup.delegation || {};
  const nativeSubagents = setup.nativeSubagents || null;
  const nativeSubagentsSignature = nativeSubagents
    ? [
      nativeSubagents.provider,
      nativeSubagents.mode,
      nativeSubagents.teamId || "",
      nativeSubagents.maxChildrenPerRound || "",
      nativeSubagents.maxParallelChildren || "",
      (nativeSubagents.teammates || []).map((agent) => [
        agent.name,
        agent.modelRef,
        agent.effort,
        (agent.allowedTools || []).join(","),
        Object.keys(agent.mcpServers || {}).join(","),
      ].join(":")).join("|"),
    ].join("\n")
    : "";
  const delegationSignature = [
    delegation.enabled ? "1" : "0",
    delegation.canDelegate ? "1" : "0",
    delegation.depth ?? "",
    delegation.maxDepth ?? "",
    delegation.maxChildrenPerRound ?? "",
    delegation.maxParallelChildren ?? "",
    delegation.autoRunChildren ? "1" : "0",
    (delegation.availableAgents || []).map((agent) => `${agent.name}:${agent.model}:${agent.effort}`).join("|"),
    (delegation.childTasks || []).map((child) => {
      const latest = child.latest_run || {};
      return [
        child.id,
        child.stage,
        child.required ? "1" : "0",
        child.owner_agent || "",
        latest.id || "",
        latest.status || "",
        latest.decision || "",
        latest.summary || "",
      ].join(":");
    }).join("|"),
  ].join("\n");
  const planningSignature = [
    setup.settings?.planning_harness || "",
    setup.settings?.planning_tool_policy || "",
    setup.planningDiagnostics?.enforceable ? "1" : "0",
    (setup.allowedTools || []).join("|"),
    (setup.disallowedTools || []).join("|"),
  ].join("\n");
  return makeContextCacheKey({
    taskId: setup.task?.id || "",
    agentName: setup.agent?.name || "",
    mode: mode || "",
    priorRunId: priorRunId || "",
    agentUpdatedAt: setup.agent?.updated_at || 0,
    taskUpdatedAt: setup.task?.updated_at || 0,
    projectId: setup.project?.id || "",
    projectUpdatedAt: setup.project?.updated_at || 0,
    projectWorkdirHash: shortHash(setup.effectiveWorkdir || ""),
    workspaceModeHash: shortHash([
      setup.workspaceMode || "direct",
      setup.sourceWorkdir || "",
      setup.worktree?.branch || "",
      setup.worktree?.status || "",
    ].join("|")),
    qaOutputHash: shortHash(setup.qaOutputDir || ""),
    projectContextHash: setup.projectContextHash || "",
    repositoryInstructionsHash: setup.repositoryInstructions?.hash || "",
    repositoryGitRootHash: shortHash(setup.repositoryGitRoot || ""),
    resumeContextHash: shortHash(setup.resumeContext || ""),
    commentsHash: shortHash((setup.commentRows || []).map((c) => `${c.id}:${c.created_at}`).join("|")),
    skillsHash: shortHash(skillsSignature.join("|")),
    mcpHash: shortHash(mcpSignature.join("|")),
    builtinHash: shortHash(builtinSignature.join("|")),
    kbHash: shortHash(pinnedSignature.join("|")),
    artifactsHash: shortHash(artifactSignature.join("|")),
    resolvedBlockersHash: shortHash(blockerSignature.join("|")),
    delegationHash: shortHash(delegationSignature),
    nativeSubagentsHash: shortHash(nativeSubagentsSignature),
    planningHash: shortHash(planningSignature),
    memoryHash: shortHash(setup.memory || ""),
    learningHash: shortHash((setup.learningMemories || []).map((memory) => `${memory.id}:${memory.updated_at}:${memory.status}`).join("|")),
    journalHash: shortHash(setup.journalTail || ""),
  });
}

export function buildTaskRunInput({ config, db, taskId, agentName, runId, mode, priorRunId = null, contextCache = null, worklabToolSurfaceMarkdown = "", now = Date.now() }) {
  const setup = loadTaskRunSetup({ config, db, taskId, agentName, runId, mode });
  const { agent, task, skills, memory, learningMemories, learningMemoryContext, journalTail, commentRows, pinnedKb, mcpServers, delegation, nativeSubagents } = setup;
  const capabilityPolicy = applyPlanningToolPolicy({
    mode,
    settings: setup.settings,
    allowedTools: setup.allowedTools,
    disallowedTools: setup.disallowedTools,
  });
  const { allowedTools, disallowedTools, toolPolicy } = capabilityPolicy;
  const runtimeDateContext = buildRuntimeDateContext({ now: setup.runStartedAt || now, timezone: config?.timezone });
  const messages = buildTaskRunMessages({ mode, task, runtimeDateContext });
  const currentRunComments = selectCurrentRunComments(db, taskId, runId, commentRows);
  const taskArtifacts = loadTaskArtifacts(db, taskId, { excludeRunId: runId });
  const resolvedBlockers = loadResolvedBlockerContext(db, taskId);

  const cache = contextCache || getProcessContextCache();
  const cacheKey = makeSetupSignature(
    { ...setup, commentRows, allowedTools, disallowedTools, mcpServers, pinnedKb, taskArtifacts, resolvedBlockers, planningDiagnostics: capabilityPolicy.diagnostics },
    { mode, priorRunId },
  );

  if (mode === "plan" || mode === "execute") {
    const priorRuns = loadPriorRunSummaries(db, taskId, runId);
    const promptInput = {
      agent, task, project: setup.project, effectiveWorkdir: setup.effectiveWorkdir, qaOutputDir: setup.qaOutputDir, skills, memory, learningMemoryContext, journalTail,
      workspaceMode: setup.workspaceMode, sourceWorkdir: setup.sourceWorkdir, worktree: setup.worktree,
      repositoryInstructions: setup.repositoryInstructions,
      repositoryGitRoot: setup.repositoryGitRoot,
      comments: commentRows, currentRunComments, pinnedKb, priorRuns, taskArtifacts, resolvedBlockers,
      settings: setup.settings,
      resumeContext: setup.resumeContext,
      taskArtifactsMarkdown: formatTaskArtifactsForPrompt(taskArtifacts),
      worklabToolSurfaceMarkdown,
      allowedTools, disallowedTools, mcpServers, delegation, nativeSubagents,
    };
    const cached = cache.get(cacheKey);
    const prompt = cached || buildSystemPrompt(promptInput, mode);
    if (!cached) cache.set(cacheKey, prompt);
    const diagnostics = {
      ...diagnosticsForPrompt(prompt, {
        ...setup,
        allowedTools,
        disallowedTools,
        taskArtifacts,
        resolvedBlockers,
        planningDiagnostics: capabilityPolicy.diagnostics,
      }),
      contextCacheHit: !!cached,
    };
    return {
      ...setup, mode, systemPrompt: prompt.text, messages, currentRunComments, priorRuns, taskArtifacts, resolvedBlockers, learningMemories, runtimeDateContext,
      allowedTools, disallowedTools, toolPolicy,
      promptDiagnostics: diagnostics,
    };
  }

  if (mode === "review") {
    if (!priorRunId) {
      throw runInputError(400, "invalid_state", "WORKLAB_PRIOR_RUN_ID is required for review mode");
    }
    const priorRun = getRunById(db, priorRunId);
    if (!priorRun) {
      throw runInputError(400, "invalid_state", `prior run ${priorRunId} not found`);
    }
    const priorLog = getAgentLogByRunId(db, priorRun.id);
    const priorEvents = priorLog ? parseEvents(priorLog.events) : [];
    const execution = extractExecutionFromEvents(priorEvents, priorRun);
    const cached = cache.get(cacheKey);
    const prompt = cached || buildSystemPrompt({
      agent, task, skills, memory, learningMemoryContext, journalTail,
      comments: commentRows, currentRunComments, pinnedKb, execution, taskArtifacts,
      resolvedBlockers,
      settings: setup.settings,
      resumeContext: setup.resumeContext,
      taskArtifactsMarkdown: formatTaskArtifactsForPrompt(taskArtifacts),
      worklabToolSurfaceMarkdown,
      allowedTools, disallowedTools, mcpServers,
      project: setup.project,
      effectiveWorkdir: setup.effectiveWorkdir,
      workspaceMode: setup.workspaceMode,
      sourceWorkdir: setup.sourceWorkdir,
      worktree: setup.worktree,
      qaOutputDir: setup.qaOutputDir,
      repositoryInstructions: setup.repositoryInstructions,
      repositoryGitRoot: setup.repositoryGitRoot,
      delegation,
      nativeSubagents,
    }, "review");
    if (!cached) cache.set(cacheKey, prompt);
    const diagnostics = {
      ...diagnosticsForPrompt(prompt, {
        ...setup,
        allowedTools,
        disallowedTools,
        taskArtifacts,
        resolvedBlockers,
        planningDiagnostics: capabilityPolicy.diagnostics,
      }),
      contextCacheHit: !!cached,
    };
    return {
      ...setup, mode, systemPrompt: prompt.text, messages, currentRunComments, runtimeDateContext,
      priorRun, priorEvents, execution, taskArtifacts, resolvedBlockers, learningMemories, promptDiagnostics: diagnostics,
      allowedTools, disallowedTools, toolPolicy,
    };
  }

  throw runInputError(400, "invalid_state", `mode ${mode} not implemented`);
}

export function buildNextTaskRunPreview({ db, config, taskId, now = Date.now(), worklabToolSurfaceMarkdown = "" }) {
  requireDataDir(config);
  const task = getTaskById(db, taskId);
  if (!task) throw runInputError(404, "not_found", "task not found");

  const stage = taskStage(task);
  const mode = modeForTaskStage(stage);
  if (!mode) throw runInputError(400, "invalid_state", `no run action in stage ${stage}`);

  const blocker = hasOpenBlocker(db, taskId);
  if (blocker) throw runInputError(400, "invalid_state", `task is blocked by "${blocker.title}"`);

  const agentName = agentForTaskStage(task, stage);
  if (!agentName) throw runInputError(400, "invalid_state", missingAgentMessageForTaskStage(stage));

  const { agent } = assertAgentRunnable(db, agentName);
  const result = nextStage(stage, { type: "run_requested", stage, mode, agentName });
  const errorSideEffect = result.sideEffects.find((sideEffect) => sideEffect.type === "error");
  if (errorSideEffect) throw runInputError(400, "invalid_transition", errorSideEffect.message);

  const priorRunId = mode === "review" ? latestPriorExecuteRunId(db, taskId) : null;
  if (mode === "review" && !priorRunId) throw runInputError(400, "invalid_state", "no execute run to review");

  const runInput = buildTaskRunInput({
    config,
    db,
    taskId,
    agentName,
    runId: `preview-${now}`,
    mode,
    priorRunId,
    now,
    worklabToolSurfaceMarkdown,
  });

  const metadata = {
    task_id: task.id,
    task_key: task.task_key || null,
    stage,
    mode,
    agent_name: agentName,
    model: agent.model,
    effort: agent.effort || "medium",
    project_id: runInput.project?.id || null,
    project_slug: runInput.project?.slug || null,
    project_name: runInput.project?.name || null,
    project_context_hash: runInput.projectContextHash || null,
    workdir: runInput.effectiveWorkdir || config.workspace || null,
    workspace_mode: runInput.workspaceMode || "direct",
    source_workdir: runInput.sourceWorkdir || null,
    worktree: runInput.worktree || null,
    planning_harness: runInput.promptDiagnostics?.planning?.harness || null,
    planning_tool_policy: runInput.promptDiagnostics?.planning?.tool_policy || null,
    generated_at: now,
  };
  const tools = [
    {
      name: "run_log_read",
      purpose: "Read a compact prior-run diagnostic summary on demand; request tail/full raw JSONL only when necessary.",
    },
  ];

  return {
    ...metadata,
    system_prompt: runInput.systemPrompt,
    messages: runInput.messages,
    input: {
      metadata,
      system: {
        format: "markdown",
        content: runInput.systemPrompt,
      },
      messages: runInput.messages.map((message) => ({
        ...message,
        format: "markdown",
      })),
      tools,
      diagnostics: runInput.promptDiagnostics,
    },
  };
}
