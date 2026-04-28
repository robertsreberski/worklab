import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "./skills.js";
import { enrichCommentRows } from "./comments.js";
import { getAvailableMcpServers } from "./mcp-config.js";
import { readJournalTail, agentMemoryPath } from "./journal.js";
import { buildPlanSystemPrompt, buildExecuteSystemPrompt, buildReviewSystemPrompt } from "./context.js";
import { WORKLAB_BUILTIN_TOOLS, resolveModel } from "./ai.js";
import { extractExecutionFromEvents } from "./review-exec.js";
import { kbListPinned } from "./kb.js";
import { parseStoredAllowlist, resolveAllowlist, resolveAllowlistMap, storedAllowlistMode } from "./agent-allowlists.js";
import { readSettings } from "./settings.js";
import { nextStage } from "./state-machine.js";
import { taskStage } from "./task-side-effects.js";

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

export function modeForTaskStage(stage) {
  if (stage === "plan") return "plan";
  if (stage === "review") return "review";
  if (stage === "execute") return "execute";
  return null;
}

export function agentForTaskStage(task, stage) {
  if (stage === "review") return task?.reviewer_agent || null;
  return task?.owner_agent || null;
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
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
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
    return [{ role: "user", content: `Review task "${task.title}". Respond with your verdict.` }];
  }
  return [{ role: "user", content: `${mode === "plan" ? "Plan" : "Work on"} task "${task.title}".` }];
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

  if (mcpServers.worklab) {
    mcpServers.worklab = {
      ...mcpServers.worklab,
      env: {
        ...(mcpServers.worklab.env || {}),
        WORKLAB_DATA_DIR: config.dataDir,
        WORKLAB_AGENT_NAME: agentName,
        WORKLAB_RUN_ID: runId,
        ...env,
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
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw runInputError(404, "not_found", `task ${taskId} not found`);
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
  if (!agent) throw runInputError(400, "invalid_state", `agent ${agentName} not found`);
  const settings = readSettings(db);

  const commentRows = enrichCommentRows(
    db,
    db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId),
  );

  const memoryPath = agentMemoryPath(config.dataDir, agentName);
  const memory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  const journalTail = readJournalTail({ dataDir: config.dataDir, agent: agentName, maxLines: settings.journal_tail_lines });
  const { skills, mcpServers, allowedTools, disallowedTools } = loadAgentCapabilities({
    config,
    agent,
    agentName,
    runId,
    env: {
      WORKLAB_TASK_ID: taskId,
      WORKLAB_TASK_TITLE: task.title,
    },
  });

  const pinnedKb = kbListPinned({ dataDir: config.dataDir, limit: settings.kb_pinned_limit });

  return { task, agent, commentRows, skills, memory, journalTail, mcpServers, allowedTools, disallowedTools, pinnedKb };
}

export function loadPriorRunSummaries(db, taskId, currentRunId, limit = 4) {
  const runs = db.prepare(
    `SELECT * FROM task_runs
      WHERE task_id = ? AND id != ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT ?`,
  ).all(taskId, currentRunId, limit);

  return runs.map((run) => {
    const logRow = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(run.id);
    const priorEvents = logRow ? parseEvents(logRow.events) : [];
    const execution = extractExecutionFromEvents(priorEvents, run);
    return {
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

export function buildTaskRunInput({ config, db, taskId, agentName, runId, mode, priorRunId = null }) {
  const setup = loadTaskRunSetup({ config, db, taskId, agentName, runId });
  const { agent, task, skills, memory, journalTail, commentRows, pinnedKb } = setup;
  const messages = buildTaskRunMessages({ mode, task });

  if (mode === "plan" || mode === "execute") {
    const priorRuns = loadPriorRunSummaries(db, taskId, runId);
    const promptInput = { agent, task, skills, memory, journalTail, comments: commentRows, pinnedKb, priorRuns };
    const systemPrompt = mode === "plan"
      ? buildPlanSystemPrompt(promptInput)
      : buildExecuteSystemPrompt(promptInput);
    return { ...setup, mode, systemPrompt, messages, priorRuns };
  }

  if (mode === "review") {
    if (!priorRunId) {
      throw runInputError(400, "invalid_state", "WORKLAB_PRIOR_RUN_ID is required for review mode");
    }
    const priorRun = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(priorRunId);
    if (!priorRun) {
      throw runInputError(400, "invalid_state", `prior run ${priorRunId} not found`);
    }
    const priorLog = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(priorRun.id);
    const priorEvents = priorLog ? parseEvents(priorLog.events) : [];
    const execution = extractExecutionFromEvents(priorEvents, priorRun);
    const systemPrompt = buildReviewSystemPrompt({
      agent,
      task,
      skills,
      memory,
      journalTail,
      comments: commentRows,
      pinnedKb,
      execution,
    });
    return { ...setup, mode, systemPrompt, messages, priorRun, priorEvents, execution };
  }

  throw runInputError(400, "invalid_state", `mode ${mode} not implemented`);
}

export function buildNextTaskRunPreview({ db, config, taskId, now = Date.now() }) {
  requireDataDir(config);
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw runInputError(404, "not_found", "task not found");

  const stage = taskStage(task);
  const mode = modeForTaskStage(stage);
  if (!mode) throw runInputError(400, "invalid_state", `no run action in stage ${stage}`);

  const blocker = hasOpenBlocker(db, taskId);
  if (blocker) throw runInputError(400, "invalid_state", `task is blocked by "${blocker.title}"`);

  const agentName = agentForTaskStage(task, stage);
  if (!agentName) throw runInputError(400, "invalid_state", mode === "review" ? "no reviewer assigned" : "no owner assigned");

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
  });

  return {
    task_id: task.id,
    task_key: task.task_key || null,
    stage,
    mode,
    agent_name: agentName,
    model: agent.model,
    effort: agent.effort || "medium",
    generated_at: now,
    system_prompt: runInput.systemPrompt,
    messages: runInput.messages,
  };
}
