import { join } from "node:path";
import { loadSkills } from "./skills.js";
import { enrichCommentRows } from "./comments.js";
import { getAvailableMcpServers } from "./mcp-config.js";
import { readAgentMemoryContext } from "./memory.js";
import { buildSystemPrompt } from "../agent/prompt/system-prompt.js";
import { WORKLAB_BUILTIN_TOOLS, resolveModel } from "./ai.js";
import { extractExecutionFromEvents } from "./review-exec.js";
import { kbListPinned } from "./kb.js";
import { parseStoredAllowlist, resolveAllowlist, resolveAllowlistMap, storedAllowlistMode } from "../agent/allowlists.js";
import { readSettings } from "./settings.js";
import { nextStage } from "./state-machine.js";
import { taskStage } from "./task-side-effects.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "./task-agents.js";
import { getProcessContextCache, makeContextCacheKey, shortHash } from "./context-cache.js";
import { getTaskById } from "./db/queries/tasks.js";
import { getLatestExecuteRunSummary, getRunById } from "./db/queries/runs.js";
import { getAgentByName } from "./db/queries/agents.js";
import { listTaskComments } from "./db/queries/comments.js";
import { getAgentLogByRunId } from "./db/queries/agent-logs.js";
import { loadRunSnapshot, resolveTaskProjectRunContext } from "./projects.js";
import { resolveRunArtifactDir } from "./run-artifact-paths.js";
import { formatTaskArtifactsForPrompt, loadTaskArtifacts } from "./run-artifacts.js";
import { buildDelegationContext } from "./delegation.js";
import { formatWorklabResultText } from "../ai/result/contract.js";

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

export function buildTaskRunMessages({ mode, task }) {
  if (mode === "review") {
    return [{
      role: "user",
      content: [
        "# Review task",
        "",
        `Task: "${task.title}"`,
        "",
        "Review this task against the instructions and respond with your verdict.",
      ].join("\n"),
    }];
  }
  if (mode === "plan") {
    return [{
      role: "user",
      content: [
        "# Plan task",
        "",
        `Task: "${task.title}"`,
        "",
        "Plan this task. Clarify the work, identify risks, and decide whether to proceed directly or delegate bounded subtasks.",
      ].join("\n"),
    }];
  }
  return [{
    role: "user",
    content: [
      "# Work on task",
      "",
      `Task: "${task.title}"`,
      "",
      "Do the task work requested by the instructions.",
    ].join("\n"),
  }];
}

export function loadAgentCapabilities({ config, agent, agentName, runId, env }) {
  requireDataDir(config);
  const availableSkills = loadSkills(join(config.dataDir, "skills")).filter((skill) => skill.enabled !== false);
  const skills = resolveAllowlist({
    mode: agent.skills_allowlist_mode,
    allowlist: parseStoredAllowlist(agent.skills_allowlist),
    all: availableSkills,
    getName: (skill) => skill.name,
  });

  const allMcpServers = getAvailableMcpServers(config.dataDir, { repoRoot: config.repoRoot });
  const mcpServers = resolveAllowlistMap({
    mode: agent.mcp_allowlist_mode,
    allowlist: parseStoredAllowlist(agent.mcp_allowlist),
    all: allMcpServers,
  });

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

  return { skills, mcpServers, allowedTools, disallowedTools };
}

export function loadTaskRunSetup({ config, db, taskId, agentName, runId }) {
  requireDataDir(config);
  const task = getTaskById(db, taskId);
  if (!task) throw runInputError(404, "not_found", `task ${taskId} not found`);
  const agent = getAgentByName(db, agentName);
  if (!agent) throw runInputError(400, "invalid_state", `agent ${agentName} not found`);
  const settings = readSettings(db);
  const runSnapshot = loadRunSnapshot(db, runId);
  const projectRunContext = resolveTaskProjectRunContext({ db, config, task, runSnapshot });
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
  const { skills, mcpServers, allowedTools, disallowedTools } = loadAgentCapabilities({
    config,
    agent,
    agentName,
    runId,
    env: {
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
    },
  });

  const pinnedKb = kbListPinned({ dataDir: config.dataDir, limit: settings.kb_pinned_limit });
  const delegation = buildDelegationContext({ db, task, settings });

  return {
    task,
    agent,
    project: projectRunContext.project,
    effectiveWorkdir: projectRunContext.effectiveWorkdir,
    qaOutputDir,
    projectContextHash: projectRunContext.projectContextHash,
    commentRows,
    skills,
    memory,
    journalTail,
    mcpServers,
    allowedTools,
    disallowedTools,
    pinnedKb,
    settings,
    delegation,
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
    } : null,
    toolCount: {
      skills: Array.isArray(skills) ? skills.length : 0,
      builtin: Array.isArray(allowedTools) ? allowedTools.filter((tool) => !disallowedTools.includes(tool)).length : 0,
      mcp: Object.keys(mcpServers || {}).length,
    },
    artifacts: setup.taskArtifacts?.summary || null,
    resolvedBlockers: Array.isArray(setup.resolvedBlockers) ? setup.resolvedBlockers.length : 0,
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
    qaOutputHash: shortHash(setup.qaOutputDir || ""),
    projectContextHash: setup.projectContextHash || "",
    commentsHash: shortHash((setup.commentRows || []).map((c) => `${c.id}:${c.created_at}`).join("|")),
    skillsHash: shortHash(skillsSignature.join("|")),
    mcpHash: shortHash(mcpSignature.join("|")),
    builtinHash: shortHash(builtinSignature.join("|")),
    kbHash: shortHash(pinnedSignature.join("|")),
    artifactsHash: shortHash(artifactSignature.join("|")),
    resolvedBlockersHash: shortHash(blockerSignature.join("|")),
    delegationHash: shortHash(delegationSignature),
    memoryHash: shortHash(setup.memory || ""),
    journalHash: shortHash(setup.journalTail || ""),
  });
}

export function buildTaskRunInput({ config, db, taskId, agentName, runId, mode, priorRunId = null, contextCache = null, worklabToolSurfaceMarkdown = "" }) {
  const setup = loadTaskRunSetup({ config, db, taskId, agentName, runId });
  const { agent, task, skills, memory, journalTail, commentRows, pinnedKb, mcpServers, allowedTools, disallowedTools, delegation } = setup;
  const messages = buildTaskRunMessages({ mode, task });
  const currentRunComments = selectCurrentRunComments(db, taskId, runId, commentRows);
  const taskArtifacts = loadTaskArtifacts(db, taskId, { excludeRunId: runId });
  const resolvedBlockers = loadResolvedBlockerContext(db, taskId);

  const cache = contextCache || getProcessContextCache();
  const cacheKey = makeSetupSignature(
    { ...setup, commentRows, allowedTools, mcpServers, pinnedKb, taskArtifacts, resolvedBlockers },
    { mode, priorRunId },
  );

  if (mode === "plan" || mode === "execute") {
    const priorRuns = loadPriorRunSummaries(db, taskId, runId);
    const promptInput = {
      agent, task, project: setup.project, effectiveWorkdir: setup.effectiveWorkdir, qaOutputDir: setup.qaOutputDir, skills, memory, journalTail,
      comments: commentRows, currentRunComments, pinnedKb, priorRuns, taskArtifacts, resolvedBlockers,
      taskArtifactsMarkdown: formatTaskArtifactsForPrompt(taskArtifacts),
      worklabToolSurfaceMarkdown,
      allowedTools, disallowedTools, mcpServers, delegation,
    };
    const cached = cache.get(cacheKey);
    const prompt = cached || buildSystemPrompt(promptInput, mode);
    if (!cached) cache.set(cacheKey, prompt);
    const diagnostics = { ...diagnosticsForPrompt(prompt, { ...setup, taskArtifacts, resolvedBlockers }), contextCacheHit: !!cached };
    return {
      ...setup, mode, systemPrompt: prompt.text, messages, currentRunComments, priorRuns, taskArtifacts, resolvedBlockers,
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
      agent, task, skills, memory, journalTail,
      comments: commentRows, currentRunComments, pinnedKb, execution, taskArtifacts,
      resolvedBlockers,
      taskArtifactsMarkdown: formatTaskArtifactsForPrompt(taskArtifacts),
      worklabToolSurfaceMarkdown,
      allowedTools, disallowedTools, mcpServers,
      project: setup.project,
      effectiveWorkdir: setup.effectiveWorkdir,
      qaOutputDir: setup.qaOutputDir,
      delegation,
    }, "review");
    if (!cached) cache.set(cacheKey, prompt);
    const diagnostics = { ...diagnosticsForPrompt(prompt, { ...setup, taskArtifacts, resolvedBlockers }), contextCacheHit: !!cached };
    return {
      ...setup, mode, systemPrompt: prompt.text, messages, currentRunComments,
      priorRun, priorEvents, execution, taskArtifacts, resolvedBlockers, promptDiagnostics: diagnostics,
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
    },
  };
}
