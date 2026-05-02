import { mkdirSync } from "node:fs";

import { parseModelReference } from "../../core/ai.js";
import { getAgentByName } from "../../core/db/queries/agents.js";
import {
  setRunDiagnostics,
  setRunExecenvPath,
  setRunWorkerPid,
} from "../../core/db/queries/runs.js";
import { prepareExecenv } from "../../core/execenv.js";
import { newRunId } from "../../core/ids.js";
import { resolveTaskProjectRunContext } from "../../core/projects.js";
import { resolveRunArtifactDir } from "../../core/run-artifact-paths.js";
import { buildRunLifecycleEvent } from "../../core/run-events.js";
import { readSettings } from "../../core/settings.js";

function assertAgentRunnable(db, agentName) {
  const agent = getAgentByName(db, agentName);
  if (!agent) throw new Error(`agent not found: ${agentName}`);
  if (!agent.enabled) throw new Error(`agent disabled: ${agentName}`);
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
}) {
  const { providerKind } = assertAgentRunnable(db, agentName);
  const settings = readSettings(db);
  const projectRunContext = resolveTaskProjectRunContext({
    db,
    config: { workspace, repoRoot },
    task,
  });
  if (projectRunContext.project?.workdir) {
    mkdirSync(projectRunContext.project.workdir, { recursive: true });
  }
  const runId = newRunId();
  const effectiveWorkspace = projectRunContext.effectiveWorkdir || workspace || repoRoot || "";
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
    if (diagnosticsSeed?.manual_retry) return "manual_retry";
    if (parentRunId) return "stage_progression";
    return null;
  })();
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, project_id, parent_run_id, parent_relationship, mode, stage, agent_name, provider_kind,
       started_at, status, process_status, retry_stage, workdir, project_context_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'running', ?, ?, ?)`,
  ).run(
    runId,
    task.id,
    projectRunContext.project?.id || null,
    parentRunId,
    parentRelationship,
    mode,
    stage,
    agentName,
    providerKind,
    now,
    stage,
    projectRunContext.effectiveWorkdir || null,
    projectRunContext.projectContextHash,
  );
  if (diagnosticsSeed && typeof diagnosticsSeed === "object") {
    setRunDiagnostics(db, runId, JSON.stringify(diagnosticsSeed));
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
    WORKLAB_DATA_DIR: dataDir || "",
    WORKLAB_REPO_ROOT: repoRoot || "",
    WORKLAB_WORKSPACE: effectiveWorkspace,
    ...(qaOutputDir ? { WORKLAB_QA_OUTPUT_DIR: qaOutputDir, PLAYWRIGHT_MCP_OUTPUT_DIR: qaOutputDir } : {}),
    ...(projectRunContext.project ? {
      WORKLAB_PROJECT_ID: projectRunContext.project.id,
      WORKLAB_PROJECT_SLUG: projectRunContext.project.slug,
      WORKLAB_PROJECT_NAME: projectRunContext.project.name,
    } : {}),
    ...(execenvPath ? { WORKLAB_EXECENV_PATH: execenvPath } : {}),
    ...(reusableSessionId ? { WORKLAB_PROVIDER_SESSION_ID: reusableSessionId } : {}),
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
    // A3: passing the agent name lets spawn-worker resolve the per-agent
    // budget.json (or fall back to the bundled defaults).
    agentName,
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
      onWorkerExit(task.id, runId, {
        exitCode: 1,
        status: "error",
        processStatus: "failed",
        error: err.message,
      });
    });

  return { runId };
}
