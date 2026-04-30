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
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, project_id, parent_run_id, mode, stage, agent_name, provider_kind,
       started_at, status, process_status, retry_stage, workdir, project_context_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'running', ?, ?, ?)`,
  ).run(
    runId,
    task.id,
    projectRunContext.project?.id || null,
    parentRunId,
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

  const args = ["--task", task.id, "--mode", mode, "--agent", agentName];
  const env = {
    WORKLAB_RUN_ID: runId,
    WORKLAB_DATA_DIR: dataDir || "",
    WORKLAB_REPO_ROOT: repoRoot || "",
    WORKLAB_WORKSPACE: projectRunContext.effectiveWorkdir || workspace || repoRoot || "",
    ...(projectRunContext.project ? {
      WORKLAB_PROJECT_ID: projectRunContext.project.id,
      WORKLAB_PROJECT_SLUG: projectRunContext.project.slug,
      WORKLAB_PROJECT_NAME: projectRunContext.project.name,
    } : {}),
    ...(execenvPath ? { WORKLAB_EXECENV_PATH: execenvPath } : {}),
  };
  if (mode === "review" && parentRunId) env.WORKLAB_PRIOR_RUN_ID = parentRunId;

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
    runIdleWarningMs,
    logInlineLimit,
    diagnosticsSeed,
  });

  setRunWorkerPid(db, runId, handle.pid);
  active.set(task.id, { runId, handle });
  activeByRunId.set(runId, { taskId: task.id, handle, providerKind });
  broker.broadcast("global", buildRunLifecycleEvent(db, "run_started", runId, { taskId: task.id }));

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
