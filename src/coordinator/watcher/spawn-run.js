import { mkdirSync } from "node:fs";

import { parseModelReference } from "../../core/ai.js";
import { getAgentByName } from "../../core/db/queries/agents.js";
import { getAcpProfileByAgentName } from "../../core/db/queries/acp-profiles.js";
import {
  getRunTodoStateRow,
  setRunDiagnostics,
  setRunExecenvPath,
  setRunTodoState,
  setRunWorkerPid,
} from "../../core/db/queries/runs.js";
import { inheritRunTodoState, serializeRunTodoState } from "../../core/run-todos.js";
import { prepareExecenv } from "../../core/execenv.js";
import { newRunId } from "../../core/ids.js";
import { resolveTaskProjectRunContext } from "../../core/projects.js";
import { effectiveTeamForTask } from "../../core/teams.js";
import { resolveRunArtifactDir } from "../../core/run-artifact-paths.js";
import { buildRunLifecycleEvent } from "../../core/run-events.js";
import { readSettings } from "../../core/settings.js";
import { inspectWorktreeSupport, prepareRunWorktree } from "../../core/worktrees.js";
import { assertAcpTaskRunPreflight } from "../../core/acp-preflight.js";

const WORKTREE_TASK_MODES = new Set(["plan", "execute", "review"]);
const PI_CODEX_TRANSPORTS = new Set(["sse", "auto", "websocket", "websocket-cached"]);

function shouldUseProjectWorktree(mode, project) {
  return WORKTREE_TASK_MODES.has(mode)
    && project?.worktree_mode
    && project.worktree_mode !== "off";
}

function assertAgentRunnable(db, agentName) {
  const agent = getAgentByName(db, agentName);
  if (!agent) throw new Error(`agent not found: ${agentName}`);
  if (!agent.enabled) throw new Error(`agent disabled: ${agentName}`);
  if (agent.sdk === "acp" || String(agent.model || "").startsWith("acp:") || agent.execution_mode === "acp") {
    return { agent, providerKind: "acp" };
  }
  try {
    return { agent, providerKind: parseModelReference(agent.model).sdk };
  } catch (err) {
    throw new Error(`invalid agent model for ${agentName}: ${err.message}`);
  }
}

export function spawnTaskRun({
  db,
  broker,
  spawn,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
  workspace,
  runTimeoutMs,
  runIdleWarningMs,
  logInlineLimit,
  active,
  activeByRunId,
  onWorkerExit,
  task,
  stage,
  mode,
  agentName,
  parentRunId = null,
  diagnosticsSeed = null,
  events,
  kind = "task",
  teamId = null,
}) {
  const { agent, providerKind } = assertAgentRunnable(db, agentName);
  const settings = readSettings(db);
  const runId = newRunId();
  const projectRunContext = resolveTaskProjectRunContext({
    db,
    config: { workspace, repoRoot },
    task,
  });
  const sourceWorkspace = projectRunContext.effectiveWorkdir || workspace || repoRoot || "";
  const wantsProjectWorktree = shouldUseProjectWorktree(mode, projectRunContext.project);
  const acpPreflight = assertAcpTaskRunPreflight({
    agent,
    profile: providerKind === "acp" ? getAcpProfileByAgentName(db, agentName) : null,
    runKind: kind,
    workspace: sourceWorkspace,
    willUseWorktree: wantsProjectWorktree,
  });
  if (projectRunContext.project?.workdir) {
    mkdirSync(projectRunContext.project.workdir, { recursive: true });
  }
  let workspaceMode = "direct";
  let sourceWorkdir = null;
  let worktreeMetadata = null;
  if (wantsProjectWorktree) {
    const support = inspectWorktreeSupport(sourceWorkspace);
    if (!support.supported) {
      if (projectRunContext.project.worktree_mode === "required") {
        throw new Error(`project worktree mode is required but unavailable: ${support.reason || "unsupported"}`);
      }
    } else {
      worktreeMetadata = prepareRunWorktree({
        sourceWorkdir: sourceWorkspace,
        runId,
        dataDir,
      });
      workspaceMode = "worktree";
      sourceWorkdir = worktreeMetadata.source_workdir;
    }
  }
  const effectiveWorkspace = worktreeMetadata?.runtime_workdir || sourceWorkspace;
  let qaOutputDir = null;
  if (effectiveWorkspace) {
    qaOutputDir = resolveRunArtifactDir({ workdir: effectiveWorkspace, runId });
    try {
      mkdirSync(qaOutputDir, { recursive: true });
    } catch (err) {
      logger?.warn?.({ err: err.message, runId, qaOutputDir }, "qa artifact directory preparation failed");
      qaOutputDir = null;
    }
  }
  const now = Date.now();
  // R11: classify the run's relationship to its parent at insert time.
  // diagnosticsSeed.continuation_of_run_id (set by maybeStartRecoveryContinuation)
  // means recovery; a stage-progression run has parent_run_id but no
  // continuation marker; manual_retry is reserved for the API path that
  // re-spawns a stage from the UI.
  const parentRelationship = (() => {
    if (diagnosticsSeed?.continuation_of_run_id) return "recovery_continuation";
    if (diagnosticsSeed?.worktree_conflict_retry) return "worktree_conflict_retry";
    if (diagnosticsSeed?.manual_retry) return "manual_retry";
    if (parentRunId) return "stage_progression";
    return null;
  })();
  const resolvedTeamId = teamId ?? (task ? effectiveTeamForTask(db, task) : null);
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, project_id, team_id, kind, parent_run_id, parent_relationship, mode, stage, agent_name, provider_kind,
       started_at, status, process_status, retry_stage, workdir, workspace_mode, source_workdir, worktree_json, project_context_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'running', ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    task.id,
    projectRunContext.project?.id || null,
    resolvedTeamId,
    kind,
    parentRunId,
    parentRelationship,
    mode,
    stage,
    agentName,
    providerKind,
    now,
    stage,
    effectiveWorkspace || null,
    workspaceMode,
    sourceWorkdir,
    worktreeMetadata ? JSON.stringify(worktreeMetadata) : null,
    projectRunContext.projectContextHash,
  );
  if (diagnosticsSeed && typeof diagnosticsSeed === "object") {
    setRunDiagnostics(db, runId, JSON.stringify(diagnosticsSeed));
  }

  // R-followup: a recovery_continuation inherits the parent run's checklist so
  // the agent can resume after a drained shutdown or provider retry without
  // losing execution context. update_count resets — it tracks writes by *this*
  // run. Stage progression and manual_retry start with the empty default.
  if (parentRelationship === "recovery_continuation") {
    const sourceRunId = diagnosticsSeed?.continuation_of_run_id || parentRunId;
    if (sourceRunId) {
      try {
        const parentTodoRow = getRunTodoStateRow(db, sourceRunId);
        const inherited = inheritRunTodoState(parentTodoRow?.todo_state_json);
        if (inherited) setRunTodoState(db, runId, serializeRunTodoState(inherited));
      } catch (err) {
        logger?.warn?.({ err: err.message, runId, sourceRunId }, "todo inheritance failed");
      }
    }
  }

  let execenvPath = null;
  if (dataDir) {
    try {
      const env = prepareExecenv({ dataDir, runId, agent: { name: agentName }, task, providerKind });
      execenvPath = env.root;
      setRunExecenvPath(db, runId, execenvPath);
    } catch (err) {
      logger?.warn?.({ err: err.message, runId }, "execenv preparation failed");
    }
  }

  // R12: when this run is a recovery continuation, resume the failed run's
  // provider_session_id. Review continuations still use parent_run_id for the
  // execute run being reviewed, so diagnostics.continuation_of_run_id is the
  // authoritative session source for that path.
  const reusableSessionId = (() => {
    if (parentRelationship !== "recovery_continuation" || !parentRunId) return null;
    try {
      const sessionSourceIds = [
        diagnosticsSeed?.continuation_of_run_id,
        parentRunId,
      ].filter(Boolean);
      for (const sourceRunId of sessionSourceIds) {
        const parent = db.prepare("SELECT provider_session_id FROM task_runs WHERE id = ?").get(sourceRunId);
        if (parent?.provider_session_id) return parent.provider_session_id;
      }
      return null;
    } catch {
      return null;
    }
  })();
  const args = ["--task", task.id, "--mode", mode, "--agent", agentName];
  const env = {
    WORKLAB_RUN_ID: runId,
    ...(kind && kind !== "task" ? { WORKLAB_RUN_KIND: kind } : {}),
    WORKLAB_DATA_DIR: dataDir || "",
    WORKLAB_REPO_ROOT: repoRoot || "",
    WORKLAB_WORKSPACE: effectiveWorkspace,
    WORKLAB_WORKSPACE_MODE: workspaceMode,
    ...(sourceWorkdir ? { WORKLAB_SOURCE_WORKDIR: sourceWorkdir } : {}),
    ...(qaOutputDir ? { WORKLAB_QA_OUTPUT_DIR: qaOutputDir, PLAYWRIGHT_MCP_OUTPUT_DIR: qaOutputDir } : {}),
    ...(projectRunContext.project ? {
      WORKLAB_PROJECT_ID: projectRunContext.project.id,
      WORKLAB_PROJECT_SLUG: projectRunContext.project.slug,
      WORKLAB_PROJECT_NAME: projectRunContext.project.name,
    } : {}),
    ...(execenvPath ? { WORKLAB_EXECENV_PATH: execenvPath } : {}),
    ...(reusableSessionId ? { WORKLAB_PROVIDER_SESSION_ID: reusableSessionId } : {}),
    ...(acpPreflight ? { WORKLAB_ACP_PROFILE_ID: acpPreflight.profileId } : {}),
    ...(PI_CODEX_TRANSPORTS.has(diagnosticsSeed?.pi_transport_override)
      ? { WORKLAB_PI_CODEX_TRANSPORT: diagnosticsSeed.pi_transport_override }
      : {}),
  };
  if (mode === "review" && parentRunId) env.WORKLAB_PRIOR_RUN_ID = parentRunId;

  // R7: review-mode idle threshold is independent of execute. The QA reviewer
  // legitimately sits on a single browser_snapshot for >130 s when the page
  // takes time to settle, so the global idle warning fires too aggressively.
  const effectiveIdleWarningMs = mode === "review"
    ? Math.max(runIdleWarningMs, Number(settings.agent_review_idle_threshold_ms ?? 240_000))
    : runIdleWarningMs;
  const handle = spawn({
    binary: workerBinary,
    args,
    env,
    runId,
    taskId: task.id,
    broker,
    db,
    logger,
    dataDir,
    cancelGraceMs: settings.cancel_grace_ms,
    runTimeoutMs: settings.worker_timeout_ms || runTimeoutMs,
    runIdleWarningMs: effectiveIdleWarningMs,
    logInlineLimit,
    diagnosticsSeed,
  });

  setRunWorkerPid(db, runId, handle.pid);
  active.set(task.id, { runId, handle });
  activeByRunId.set(runId, { taskId: task.id, handle, providerKind });
  const startedEvent = buildRunLifecycleEvent(db, "run_started", runId, { taskId: task.id });
  broker.broadcast("global", startedEvent);
  events?.emit?.("run:started", startedEvent);

  handle.done
    .then((result) => onWorkerExit(task.id, runId, result))
    .catch((err) => {
      logger?.error?.({ err, taskId: task.id, runId }, "worker promise rejected");
      return onWorkerExit(task.id, runId, {
        exitCode: 1,
        status: "error",
        processStatus: "failed",
        error: err.message,
      });
    });

  return { runId };
}
