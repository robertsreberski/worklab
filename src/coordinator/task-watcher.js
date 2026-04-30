import { mkdirSync } from "node:fs";
import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_REJECTIONS,
  nextStage,
} from "../core/state-machine.js";
import { newRunId, newCommentId, newTaskId } from "../core/ids.js";
import { parseVerdict } from "../core/review.js";
import { formatWorklabResultText, stripWorklabResultJson, synthesizeWorklabResult } from "../core/worklab-result.js";
import { parseModelReference } from "../core/ai.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import { resumeWaitingParents } from "../core/task-joins.js";
import { nextTaskKey, resolveTaskId } from "../core/task-keys.js";
import { readSettings } from "../core/settings.js";
import { supportsLiveInputProvider } from "../core/live-input.js";
import { buildRunLifecycleEvent } from "../core/run-events.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "../core/task-agents.js";
import { prepareExecenv } from "../core/execenv.js";
import { kbCreate, kbRead, kbUpdate } from "../core/kb.js";
import { slugify } from "../core/slugs.js";
import { resolveTaskProjectRunContext } from "../core/projects.js";
import { retryableProviderFailureInfo } from "../core/failure-kind.js";
import { delegationDepth } from "../core/delegation.js";
import { getTaskById } from "../core/db/queries/tasks.js";
import {
  getRunById,
  getRunCoreFields,
  getRunDiagnostics,
  getRunTranscriptTail,
  getRunWarningsAndDiagnostics,
  setRunDiagnostics,
  setRunExecenvPath,
  setRunWorkerPid,
} from "../core/db/queries/runs.js";
import {
  enabledAgentExists,
  getAgentBudget,
  getAgentByName,
  getAgentPerRunBudget,
  getAgentSelfReviewFlag,
} from "../core/db/queries/agents.js";
import {
  findOpenBlocker,
  insertDependency,
  listDependentsOf,
} from "../core/db/queries/task-dependencies.js";

const RICH_FINAL_MIN_CHARS = 800;
const KB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWLEDGE_LINK_RE = /#\/knowledge\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

function runProcessStatus(runOrResult) {
  return runOrResult?.processStatus || runOrResult?.process_status || "running";
}

function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function modeForStage(stage) {
  if (stage === "plan") return "plan";
  return stage === "review" ? "review" : "execute";
}

const AUTO_RUN_POLICY = "auto_plan_execute";

function buildFallbackResult({ stage, mode, res }) {
  if (stage === "review" || mode === "review") {
    // Worker's reviewResultFromText handles the verdict-line parse already; if
    // we still don't have a worklab_result here it means the reviewer emitted
    // neither valid JSON nor a usable VERDICT line. Returning null causes
    // handleSuccessfulExit to escalate via handleFailedExit (failure_kind
    // "invalid_result"). DO NOT synthesise an "advance" here — that would
    // silently approve the reviewer's broken output.
    const verdictEvent = Array.isArray(res.events)
      ? res.events.find((event) => event?.type === "verdict")
      : null;
    const verdict = verdictEvent?.verdict || parseVerdict(res.finalText).verdict;
    const notes = verdictEvent?.notes || parseVerdict(res.finalText).notes || "";
    if (verdict === "APPROVE") {
      return synthesizeWorklabResult({ stage: "review", decision: "approve", summary: notes || "Approved", details: res.finalText || "" });
    }
    if (verdict === "REJECT") {
      return synthesizeWorklabResult({ stage: "review", decision: "reject", summary: notes || "Rejected", details: res.finalText || "" });
    }
    return null;
  }
  if (!String(res.finalText || "").trim()) return null;
  return synthesizeWorklabResult({
    stage,
    decision: "advance",
    summary: res.finalText ? String(res.finalText).trim().slice(0, 500) : "Run completed",
    details: res.finalText || "",
  });
}

function collapseDuplicateParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return raw;
  const seen = new Set();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n");
}

function sanitizeAgentText(text) {
  return collapseDuplicateParagraphs(stripWorklabResultJson(text));
}

function structuredFinalText(result) {
  const value = result?.worklab_result || result;
  if (!value || value.schema !== "worklab.v2") return "";
  return sanitizeAgentText(value.final_text || "");
}

function agentCommentBody(result, finalText) {
  const structured = structuredFinalText(result);
  if (structured) return structured;
  const delivered = sanitizeAgentText(finalText);
  if (delivered) return delivered;
  return sanitizeAgentText(formatWorklabResultText(result));
}

function normalizedComparableText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function firstMeaningfulParagraph(text, limit = 500) {
  const paragraph = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find(Boolean) || "";
  if (paragraph.length <= limit) return paragraph;
  return `${paragraph.slice(0, limit - 3).trimEnd()}...`;
}

function assistantTextsFromEvents(events = []) {
  const texts = [];
  for (const wrapper of Array.isArray(events) ? events : []) {
    const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
    const content = event?.message?.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts;
}

function isDistinctRichFinal(text, commentBody) {
  const body = String(text || "").trim();
  if (body.length < RICH_FINAL_MIN_CHARS) return false;
  const comparableBody = normalizedComparableText(body);
  const comparableComment = normalizedComparableText(commentBody);
  if (!comparableBody) return false;
  if (comparableBody === comparableComment) return false;
  return true;
}

function richFinalAnswerFromRun({ finalText, events, commentBody }) {
  const candidates = [
    sanitizeAgentText(finalText),
    ...assistantTextsFromEvents(events).reverse().map((text) => sanitizeAgentText(text)),
  ];
  for (const candidate of candidates) {
    if (isDistinctRichFinal(candidate, commentBody)) return candidate;
  }
  return "";
}

function conciseCommentForLinkedAnswer(result, richText) {
  const structured = structuredFinalText(result);
  if (structured) return structured;
  const summary = sanitizeAgentText(result?.summary || "");
  if (summary) return summary;
  return firstMeaningfulParagraph(richText);
}

function runResultKbSlug(runId) {
  return slugify(`run-${runId}`, "run-result");
}

function runResultKbTags({ task, stage, agentName }) {
  const taskRef = task?.task_key || task?.id || "task";
  return [
    "run-result",
    `task-${slugify(taskRef, "task")}`,
    slugify(stage || "run", "run"),
    `agent-${slugify(agentName || "agent", "agent")}`,
  ];
}

function runResultKbTitle({ task, agentName }) {
  const taskRef = task?.task_key || task?.title || "Task";
  return `${taskRef} final answer${agentName ? ` from ${agentName}` : ""}`;
}

function runResultKbBody({ task, runId, stage, agentName, richText }) {
  const taskRef = task?.task_key || task?.id || "task";
  const taskTitle = task?.title ? ` - ${task.title}` : "";
  return [
    `Source task: [${taskRef}${taskTitle}](#/tasks/${encodeURIComponent(taskRef)})`,
    `Source run: [${runId}](/api/runs/${encodeURIComponent(runId)}/raw-log)`,
    `Stage: ${stage || "execute"}`,
    `Agent: ${agentName || "agent"}`,
    "",
    "---",
    "",
    richText,
  ].join("\n");
}

function appendKbLink(body, slug) {
  const clean = String(body || "").trim();
  const link = `Full final answer: [Knowledge entry](#/knowledge/${slug})`;
  if (!clean) return link;
  if (clean.includes(`#/knowledge/${slug}`)) return clean;
  return `${clean}\n\n${link}`;
}

function firstKnowledgeSlugFromText(text) {
  const body = String(text || "");
  KNOWLEDGE_LINK_RE.lastIndex = 0;
  const match = KNOWLEDGE_LINK_RE.exec(body);
  return match?.[1] || null;
}

function toolBlocksFromRunEvents(events = []) {
  const blocks = [];
  for (const wrapper of Array.isArray(events) ? events : []) {
    const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" || block?.type === "tool_result") blocks.push(block);
    }
  }
  return blocks;
}

function compactRecoveryRunSummary({ runId, res, reason, providerInfo }) {
  const diagnostics = res?.diagnostics || {};
  const blocks = toolBlocksFromRunEvents(res?.events);
  const changedFiles = [];
  const actions = [];
  const failures = [];
  for (const block of blocks) {
    if (block.type === "tool_use") {
      const input = block.input || {};
      const path = input.file_path || input.path || input.command || input.pattern || "";
      actions.push(`${block.name || "tool"}${path ? `: ${String(path).slice(0, 180)}` : ""}`);
      if (["Write", "Edit"].includes(block.name) && input.file_path) changedFiles.push(input.file_path);
    }
    if (block.type === "tool_result" && block.is_error) {
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content || {});
      failures.push(content.slice(0, 240));
    }
    const changes = block.content?.changes || block.raw_result?.changes || [];
    for (const change of Array.isArray(changes) ? changes : []) {
      if (change?.path) changedFiles.push(change.path);
    }
  }
  const largest = Array.isArray(diagnostics.largest_tool_events) ? diagnostics.largest_tool_events[0] : null;
  const broadScan = Array.isArray(diagnostics.broad_scan_events) ? diagnostics.broad_scan_events[0] : null;
  const uniqueFiles = [...new Set(changedFiles)].slice(0, 12);
  const errorText = String(res?.error || "").trim();
  const turnCount = Number(diagnostics.turn_count || diagnostics.turnCount || 0);
  const piErrorCode = diagnostics.pi_error_code || null;
  const intro = reason === "usage_limit"
    ? `Previous run \`${runId}\` hit the model context limit.`
    : providerInfo?.subkind === "terminated"
      ? `Previous run \`${runId}\` was interrupted by a provider connection drop${turnCount ? ` after ${turnCount} turn(s)` : ""}${piErrorCode ? ` (${piErrorCode})` : ""}.`
      : `Previous run \`${runId}\` ended with a retryable provider error${providerInfo?.subkind ? ` (${providerInfo.subkind})` : ""}.`;
  const lines = [
    intro,
    providerInfo?.requestId ? `Provider request ID: ${providerInfo.requestId}` : "",
    errorText ? `Error: ${errorText.slice(0, 500)}` : "",
    largest ? `Largest tool payload: ${largest.tool || "unknown tool"} ${largest.role || "event"} (${largest.chars || 0} chars).` : "",
    broadScan ? `Broad scan detected: ${broadScan.tool || "tool"} ${broadScan.pattern || ""} ${broadScan.path || ""}`.trim() : "",
    uniqueFiles.length ? `Files touched before the failure:\n- ${uniqueFiles.join("\n- ")}` : "",
    failures.length ? `Tool failures before retry:\n- ${failures.join("\n- ")}` : "",
    actions.length ? `Recent tool actions:\n- ${actions.slice(-10).join("\n- ")}` : "",
  ].filter(Boolean);
  return lines.join("\n\n");
}

function parseMaybeJson(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || !/^[{[]/.test(text)) return null;
    return safeParseJson(text, null);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item?.type === "text") {
        const parsed = parseMaybeJson(item.text);
        if (parsed) return parsed;
      }
    }
    return null;
  }
  if (value && typeof value === "object") return value;
  return null;
}

function validKbSlug(value) {
  const slug = String(value || "").trim();
  return KB_SLUG_RE.test(slug) ? slug : null;
}

function slugFromToolPayload(value) {
  const parsed = parseMaybeJson(value) || value;
  if (!parsed || typeof parsed !== "object") return null;
  return validKbSlug(parsed.slug || parsed.input?.slug || parsed.result?.slug);
}

function isWorklabKbWriteTool(name) {
  return name === "kb_create"
    || name === "kb_update"
    || name === "worklab_kb_create"
    || name === "worklab_kb_update"
    || /^mcp__worklab__kb_(create|update)$/.test(String(name || ""));
}

function eventContentBlocks(wrapper) {
  const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
  if (event?.type === "tool_result") return [event];
  const content = event?.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

function toolResultSucceeded(block) {
  if (block?.is_error || block?.isError) return false;
  const parsed = parseMaybeJson(block?.content ?? block?.output ?? block?.result);
  if (parsed && typeof parsed === "object") {
    if (parsed.ok === false || parsed.error) return false;
  }
  return true;
}

function successfulKbWriteFromEvents(events = []) {
  const calls = new Map();
  for (const wrapper of Array.isArray(events) ? events : []) {
    for (const block of eventContentBlocks(wrapper)) {
      if (block?.type === "tool_use" && isWorklabKbWriteTool(block.name)) {
        const id = block.id || block.tool_use_id;
        if (id) calls.set(id, { slug: slugFromToolPayload(block.input || block.arguments) });
        continue;
      }
      if (block?.type !== "tool_result" || !toolResultSucceeded(block)) continue;
      const call = calls.get(block.tool_use_id || block.id);
      if (!call) continue;
      return {
        wrote: true,
        slug: slugFromToolPayload(block.content ?? block.output ?? block.result) || call.slug,
      };
    }
  }
  return { wrote: false, slug: null };
}

function looksLikePlanBody(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  const sectionNames = "(?:Plan|Implementation Plan|Test Plan|Approach|Implementation|Risks?|Caveats?|Out of scope)";
  return new RegExp(`^#{1,3}\\s+${sectionNames}(?:\\s*[:\\-].*|\\s*)$`, "im").test(body)
    || new RegExp(`^\\*\\*${sectionNames}(?:\\*\\*|\\s*[:\\-])`, "im").test(body)
    || new RegExp(`^${sectionNames}\\s*:`, "im").test(body);
}

// In-memory cycle check across a freshly-delegated batch of subtasks. Each
// subtask references siblings by title (or by external task id, which we
// ignore for the within-batch cycle check). DFS with three-color marks.
function detectSubtaskCycles(subtasks) {
  const titleToIndex = new Map();
  subtasks.forEach((subtask, index) => {
    const title = (subtask?.title || "").trim();
    if (title) titleToIndex.set(title, index);
  });
  const graph = subtasks.map((subtask) => {
    const deps = Array.isArray(subtask?.depends_on) ? subtask.depends_on : [];
    return deps
      .map((dep) => titleToIndex.get((dep || "").trim()))
      .filter((index) => typeof index === "number");
  });
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(subtasks.length).fill(WHITE);
  function visit(i) {
    if (color[i] === GRAY) return true;
    if (color[i] === BLACK) return false;
    color[i] = GRAY;
    for (const j of graph[i]) if (visit(j)) return true;
    color[i] = BLACK;
    return false;
  }
  for (let i = 0; i < subtasks.length; i += 1) {
    if (color[i] === WHITE && visit(i)) return true;
  }
  return false;
}

function appendDelegationDoneCriteria(instructions, subtask) {
  const parts = [String(instructions || "").trim()].filter(Boolean);
  const acceptance = Array.isArray(subtask?.acceptance_criteria)
    ? subtask.acceptance_criteria.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (acceptance.length) {
    parts.push(`Acceptance criteria:\n- ${acceptance.join("\n- ")}`);
  }
  const artifact = String(subtask?.expected_artifact || "").trim();
  if (artifact) {
    parts.push(`Expected artifact: ${artifact}`);
  }
  return parts.join("\n\n");
}

export function createTaskWatcher({
  db,
  broker,
  spawn,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
  workspace,
  runTimeoutMs = 30 * 60 * 1000,
  runIdleWarningMs = 120 * 1000,
  logInlineLimit = 12_000,
  maxFailures = null,
  events,
}) {
  const active = new Map();
  const activeByRunId = new Map();
  // Tasks for which an auto-start has been scheduled (via setTimeout) but the
  // worker has not yet been spawned. Prevents duplicate kicks when sibling
  // children complete in the same tick or a child finishes during a fresh
  // delegation round.
  const pendingStarts = new Set();
  const recoveryTimers = new Set();

  function canAutoStart(taskId) {
    const task = getTaskById(db, taskId);
    if (!task) return false;
    const stage = taskStage(task);
    if (task.run_policy !== AUTO_RUN_POLICY) return false;
    if (!["plan", "execute", "review"].includes(stage)) return false;
    if (!agentForTaskStage(task, stage)) return false;
    if (active.has(taskId) || pendingStarts.has(taskId)) return false;
    if (hasOpenBlocker(taskId)) return false;
    return true;
  }

  function scheduleAutoStart(taskId, onError) {
    if (!canAutoStart(taskId)) return;
    if (active.has(taskId) || pendingStarts.has(taskId)) return;
    pendingStarts.add(taskId);
    setTimeout(() => {
      pendingStarts.delete(taskId);
      if (!canAutoStart(taskId)) return;
      handleRunRequested(taskId).catch(onError);
    }, 0);
  }

  function maybeAutoStartTask(taskId, onError) {
    scheduleAutoStart(taskId, onError || ((err) => {
      logger?.warn?.({ err, taskId }, "task auto-run failed");
      annotateTaskFailure(taskId, { message: `Auto-run failed: ${err.message}`, failureKind: "spawn" });
    }));
  }

  function maybeAutoStartDependents(taskId, onError) {
    const rows = listDependentsOf(db, taskId);
    for (const row of rows) {
      scheduleAutoStart(row.task_id, onError || ((err) => {
        logger?.warn?.({ err, taskId: row.task_id, dependencyId: taskId }, "dependent task auto-run failed");
        annotateTaskFailure(row.task_id, { message: `Auto-run failed: ${err.message}`, failureKind: "spawn" });
      }));
    }
  }

  {
    const now = Date.now();
    const reconcile = db.transaction(() => {
      const stale = db.prepare(
        `SELECT id, task_id, stage FROM task_runs
         WHERE process_status = 'running' OR status = 'running'`,
      ).all();
      if (stale.length === 0) return 0;
      const markRun = db.prepare(
        `UPDATE task_runs
         SET process_status = 'abandoned', status = 'error', ended_at = ?,
             failure_kind = 'abandoned', error_text = ?,
             cancel_initiator = COALESCE(cancel_initiator, 'stale_reconcile'),
             cancel_reason = COALESCE(cancel_reason, 'coordinator restarted while run was active')
         WHERE id = ?`,
      );
      const markTask = db.prepare(
        `UPDATE tasks
         SET stage = CASE WHEN stage = 'done' THEN stage ELSE COALESCE(?, stage, 'plan') END,
             error_text = COALESCE(error_text, ?),
             stage_reason = COALESCE(stage_reason, 'abandoned'),
             updated_at = ?
         WHERE id = ?`,
      );
      for (const row of stale) {
        const retryStage = row.stage || "plan";
        markRun.run(now, "coordinator restarted", row.id);
        markTask.run(retryStage, "Previous run did not finish", now, row.task_id);
      }
      return stale.length;
    });
    const count = reconcile();
    if (count > 0) logger?.warn?.({ count }, "reconciled stale running runs at boot");
  }

  // Apply a list of side-effects to the DB inside a single transaction, plus
  // associated task-comments. spawn_worker / spawn_reviewer / create_subtasks
  // are owned by the caller (they need spawn machinery / DB writes outside
  // this transaction) and are handled as no-ops here.
  const applyTx = db.transaction((taskId, sideEffects, currentStage, newStage, options = {}) => {
    applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { logger });
  });

  function maxFailureLimit() {
    const settings = readSettings(db);
    return Number(maxFailures ?? settings.max_failure_streak ?? DEFAULT_MAX_FAILURES);
  }

  function maxRejectionLimit() {
    const settings = readSettings(db);
    return Number(settings.max_rejection_streak ?? DEFAULT_MAX_REJECTIONS);
  }

  function applySideEffects(taskId, sideEffects, currentStage, newStage, options = {}) {
    applyTx(taskId, sideEffects, currentStage, newStage, options);
    broker.broadcast("global", { type: "task_updated", id: taskId });
  }

  function annotateTaskFailure(taskId, { message, failureKind = "spawn", retryStage }) {
    const task = getTaskById(db, taskId);
    if (!task) return;
    const stage = retryStage || taskStage(task);
    const next = nextStage(taskStage(task), {
      type: "run_failed",
      retryStage: stage,
      failureKind,
      message,
      failureCount: task.failure_count || 0,
      maxFailures: maxFailureLimit(),
    });
    applySideEffects(taskId, next.sideEffects, taskStage(task), next.stage);
  }

  function assertAgentRunnable(agentName) {
    const agent = getAgentByName(db, agentName);
    if (!agent) throw new Error(`agent not found: ${agentName}`);
    if (!agent.enabled) throw new Error(`agent disabled: ${agentName}`);
    try {
      return { agent, providerKind: parseModelReference(agent.model).sdk };
    } catch (err) {
      throw new Error(`invalid agent model for ${agentName}: ${err.message}`);
    }
  }

  function hasOpenBlocker(taskId) {
    return findOpenBlocker(db, taskId);
  }

  function latestPriorExecuteRunId(taskId) {
    return db.prepare(`
      SELECT id
      FROM task_runs
      WHERE task_id = ?
        AND mode = 'execute'
      ORDER BY ended_at DESC, started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId)?.id || null;
  }

  function spawnRun({ task, stage, mode, agentName, parentRunId = null, diagnosticsSeed = null }) {
    const { providerKind } = assertAgentRunnable(agentName);
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

  function checkBudget({ agentName, taskId }) {
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

  function recordPerRunBudgetOverage({ runId, agentName, costUsd }) {
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

  async function handleRunRequested(taskId, options = {}) {
    const task = getTaskById(db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (active.has(taskId)) throw new Error("task already running");

    const stage = options.stage || taskStage(task);
    const blocker = hasOpenBlocker(taskId);
    if (blocker) throw new Error(`task is blocked by "${blocker.title}"`);

    const mode = options.mode || modeForStage(stage);
    const agentName = options.agentName || agentForTaskStage(task, stage);
    if (!agentName) throw new Error(missingAgentMessageForTaskStage(stage));

    const result = nextStage(stage, { type: "run_requested", stage, mode, agentName });
    const errorSideEffect = result.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) throw new Error(errorSideEffect.message);

    const parentRunId = options.parentRunId || (mode === "review" ? latestPriorExecuteRunId(taskId) : null);
    if (mode === "review" && !parentRunId) throw new Error("no execute run to review");

    if (mode === "review") {
      const reviewerCheck = enforceNoSelfReview({ taskId, reviewerAgent: agentName });
      if (!reviewerCheck.ok) {
        const err = new Error(reviewerCheck.message);
        err.code = "self_review_disallowed";
        throw err;
      }
    }

    if (!options.skipBudgetCheck) {
      const budget = checkBudget({ agentName, taskId });
      if (!budget.ok) {
        annotateTaskFailure(taskId, {
          message: budget.message,
          failureKind: "budget_exceeded",
          retryStage: stage,
        });
        const err = new Error(budget.message);
        err.code = "budget_exceeded";
        throw err;
      }
    }

    const run = spawnRun({ task, stage, mode, agentName, parentRunId });
    applySideEffects(taskId, result.sideEffects, stage, result.stage, { running: true });
    return run;
  }

  function enforceNoSelfReview({ taskId, reviewerAgent }) {
    const reviewer = getAgentSelfReviewFlag(db, reviewerAgent);
    if (reviewer?.allow_self_review) return { ok: true };
    const lastExecutor = db.prepare(`
      SELECT agent_name
      FROM task_runs
      WHERE task_id = ? AND mode = 'execute'
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId);
    if (!lastExecutor) return { ok: true };
    if (lastExecutor.agent_name === reviewerAgent) {
      return {
        ok: false,
        message: `${reviewerAgent} cannot review their own execute run; assign a different reviewer or enable allow_self_review on the agent.`,
      };
    }
    return { ok: true };
  }

  function persistRunResultKnowledge({ task, runId, stage, agentName, result, finalText, events, commentBody }) {
    if (!dataDir || stage !== "execute" || result?.decision !== "advance") return null;
    const richText = richFinalAnswerFromRun({ finalText, events, commentBody });
    if (!richText) return null;
    const slug = runResultKbSlug(runId);
    const title = runResultKbTitle({ task, agentName });
    const body = runResultKbBody({ task, runId, stage, agentName, richText });
    const patch = {
      title,
      body,
      tags: runResultKbTags({ task, stage, agentName }),
      category: "run-results",
      pinned: false,
    };
    try {
      if (kbRead({ dataDir, slug })) {
        kbUpdate({ dataDir, slug, patch });
      } else {
        kbCreate({ dataDir, slug, author: agentName || "agent", ...patch });
      }
      broker?.broadcast?.("global", { type: "kb_updated", slug });
      return { slug, title, richText };
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err), runId, slug }, "failed to persist rich final answer");
      return null;
    }
  }

  function postAgentFinalComment(taskId, agentName, result, finalText, options = {}) {
    let body = agentCommentBody(result, finalText);
    const linkedSlug = firstKnowledgeSlugFromText(body) || firstKnowledgeSlugFromText(finalText);
    const kbWrite = linkedSlug ? { wrote: true, slug: linkedSlug } : successfulKbWriteFromEvents(options.events);
    if (kbWrite.wrote) {
      if (kbWrite.slug) body = appendKbLink(body, kbWrite.slug);
    } else {
      const kbEntry = persistRunResultKnowledge({
        ...options,
        agentName,
        result,
        finalText,
        commentBody: body,
      });
      if (kbEntry) body = appendKbLink(conciseCommentForLinkedAnswer(result, kbEntry.richText) || body, kbEntry.slug);
    }
    if (!body) return;
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    ).run(newCommentId(), taskId, agentName, body, Date.now());
  }

  function updateRunResult(runId, result) {
    if (!result) return;
    db.prepare(
      `UPDATE task_runs
       SET decision = ?, summary = COALESCE(summary, ?), details = COALESCE(details, ?),
           result_json = COALESCE(result_json, ?)
       WHERE id = ?`,
    ).run(result.decision || null, result.summary || null, result.details || null, JSON.stringify(result), runId);
  }

  function planBodyFromRun(result, finalText) {
    const structuredPlan = sanitizeAgentText(result?.details);
    if (looksLikePlanBody(structuredPlan)) return structuredPlan;
    const rawPlan = sanitizeAgentText(finalText);
    if (looksLikePlanBody(rawPlan)) return rawPlan;
    for (const candidate of [structuredPlan, result?.summary, rawPlan]) {
      const body = sanitizeAgentText(candidate);
      if (body) return body;
    }
    return "";
  }

  function planBodySideEffect(runId, agentName, result, finalText) {
    const body = planBodyFromRun(result, finalText);
    if (!body) return null;
    return {
      type: "set_plan_body",
      body,
      runId,
      updatedBy: agentName || "agent",
    };
  }

  function postSystemComment(taskId, body) {
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
       VALUES (?, ?, 'system', ?, ?)`,
    ).run(newCommentId(), taskId, body, Date.now());
  }

  function loadResumeSnapshot(runId) {
    if (!runId) return null;
    try {
      const row = getRunTranscriptTail(db, runId);
      if (!row?.transcript_tail_json) return null;
      const parsed = safeParseJson(row.transcript_tail_json, null);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function patchRunDiagnostics(runId, patch) {
    const row = getRunDiagnostics(db, runId);
    if (!row) return;
    const existing = safeParseJson(row.diagnostics_json, {});
    db.prepare("UPDATE task_runs SET diagnostics_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
        ...patch,
      }),
      runId,
    );
  }

  function continuationLineage(run) {
    const seen = new Set();
    const lineage = [run.id];
    let parentId = run.parent_run_id;
    while (parentId && !seen.has(parentId) && lineage.length < 50) {
      seen.add(parentId);
      const parent = db.prepare("SELECT id, parent_run_id FROM task_runs WHERE id = ?").get(parentId);
      if (!parent) break;
      lineage.push(parent.id);
      parentId = parent.parent_run_id;
    }
    return {
      rootRunId: lineage[lineage.length - 1] || run.id,
      depth: lineage.length - 1,
      lineage,
    };
  }

  function providerRecoveryDelay(settings, attempt) {
    const base = Number(settings.agent_provider_recovery_base_delay_ms ?? 30000);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const raw = Math.min(300000, Math.floor(base * (2 ** Math.max(0, attempt - 1))));
    const jitter = Math.floor(raw * 0.2 * Math.random());
    return raw + jitter;
  }

  function recoveryReason({ failureKind, res, run, settings }) {
    if (failureKind === "usage_limit") {
      return { reason: "usage_limit", providerInfo: null };
    }
    if (failureKind !== "provider_unavailable") return null;
    if (settings.agent_provider_recovery_enabled === false) return null;
    const diagnostics = {
      ...safeParseJson(run?.diagnostics_json, {}),
      ...(res?.diagnostics || {}),
    };
    const providerInfo = diagnostics.retryable_provider_error
      ? {
          retryable: true,
          subkind: diagnostics.provider_error_subkind || "retryable_request",
          requestId: diagnostics.provider_request_id || null,
        }
      : retryableProviderFailureInfo({
          errorText: res?.error || run?.error_text || "",
          stderrTail: diagnostics.stderr_tail || "",
          failureKind,
        });
    if (!providerInfo.retryable) return null;
    return {
      reason: diagnostics.context_risk === "high" ? "provider_retryable_context_risk" : "provider_retryable",
      providerInfo,
    };
  }

  function maybeStartRecoveryContinuation({ taskId, runId, res, task, run, stage, failureKind, processStatus, nextStageValue }) {
    if (processStatus !== "failed") return null;
    if (!["plan", "execute"].includes(stage)) return null;
    const existing = db.prepare("SELECT id FROM task_runs WHERE parent_run_id = ? LIMIT 1").get(runId);
    if (existing) return null;
    const settings = readSettings(db);
    const recovery = recoveryReason({ failureKind, res, run, settings });
    if (!recovery) return null;
    const continuationLimit = Number(settings.agent_recovery_continuation_limit ?? 3);
    if (continuationLimit <= 0) return null;
    const lineage = continuationLineage(run);
    if (lineage.depth >= continuationLimit) {
      postSystemComment(taskId, `Automatic continuation skipped: recovery continuation limit reached (${lineage.depth}/${continuationLimit}).`);
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "limit_reached",
        continuation_reason: recovery.reason,
        continuation_depth: lineage.depth,
        continuation_limit: continuationLimit,
        continuation_root_run_id: lineage.rootRunId,
      });
      return null;
    }

    const agentName = run.agent_name || agentForTaskStage(task, stage);
    if (!agentName) return null;
    const budget = checkBudget({ agentName, taskId });
    if (!budget.ok) {
      postSystemComment(taskId, `Automatic continuation skipped: ${budget.message}`);
      return null;
    }

    const continuationStage = ["plan", "execute"].includes(nextStageValue) ? nextStageValue : stage;
    const attempt = lineage.depth + 1;
    const delayMs = recovery.reason === "usage_limit" ? 0 : providerRecoveryDelay(settings, attempt);
    const resumeSnapshot = recovery.reason === "provider_retryable"
      ? loadResumeSnapshot(runId)
      : null;
    const summary = compactRecoveryRunSummary({
      runId,
      res,
      reason: recovery.reason === "usage_limit" ? "usage_limit" : "provider_retryable",
      providerInfo: recovery.providerInfo,
    });
    const heading = recovery.reason === "usage_limit"
      ? "Automatic continuation after context-window overflow."
      : `Automatic continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`;
    postSystemComment(taskId, [
      heading,
      delayMs > 0 ? `Retrying in ${Math.round(delayMs / 1000)} seconds.` : "",
      "",
      summary,
      "",
      "Continue from the current workspace state. Do not repeat completed work. Do not repeat broad repository scans such as `Glob **/*`; inspect targeted files only and avoid generated/vendor directories.",
    ].filter(Boolean).join("\n").trim());
    applySideEffects(taskId, [
      { type: "clear_error_text" },
      { type: "set_stage_reason", reason: `continuing after ${recovery.reason}` },
    ], nextStageValue, continuationStage, { running: true });

    patchRunDiagnostics(runId, {
      continuation_scheduled: true,
      continuation_delay_ms: delayMs,
      continuation_depth: lineage.depth,
      continuation_limit: continuationLimit,
      continuation_reason: recovery.reason,
      continuation_root_run_id: lineage.rootRunId,
      retryable_provider_error: recovery.providerInfo?.retryable || undefined,
      provider_error_subkind: recovery.providerInfo?.subkind || undefined,
      provider_request_id: recovery.providerInfo?.requestId || undefined,
    });

    const startContinuation = () => {
      if (active.has(taskId)) {
        patchRunDiagnostics(runId, {
          continuation_skipped: true,
          continuation_skip_reason: "task_already_running",
        });
        return null;
      }
      const continuation = spawnRun({
        task: { ...task, stage: continuationStage },
        stage,
        mode: run.mode || modeForStage(stage),
        agentName,
        parentRunId: runId,
        diagnosticsSeed: {
          continuation_of_run_id: runId,
          continuation_root_run_id: lineage.rootRunId,
          continuation_reason: recovery.reason,
          continuation_depth: attempt,
          continuation_limit: continuationLimit,
          recovery_attempt: attempt,
          recovery_delay_ms: delayMs,
          retryable_provider_error: recovery.providerInfo?.retryable || undefined,
          provider_error_subkind: recovery.providerInfo?.subkind || undefined,
          provider_request_id: recovery.providerInfo?.requestId || undefined,
          resume_snapshot: resumeSnapshot || undefined,
        },
      });
      patchRunDiagnostics(runId, {
        continuation_run_id: continuation.runId,
        continuation_depth: lineage.depth,
        continuation_limit: continuationLimit,
        continuation_reason: recovery.reason,
        continuation_root_run_id: lineage.rootRunId,
      });
      return continuation;
    };

    if (delayMs > 0) {
      pendingStarts.add(taskId);
      const timer = setTimeout(() => {
        recoveryTimers.delete(timer);
        pendingStarts.delete(taskId);
        try {
          startContinuation();
        } catch (err) {
          postSystemComment(taskId, `Automatic continuation failed to start: ${err.message || String(err)}`);
        }
      }, delayMs);
      timer.unref?.();
      recoveryTimers.add(timer);
      return { scheduled: true, delayMs };
    }

    try {
      return startContinuation();
    } catch (err) {
      postSystemComment(taskId, `Automatic continuation failed to start: ${err.message || String(err)}`);
      return null;
    }
  }

  function validateDelegationRequest(parentTask, subtasks) {
    const settings = readSettings(db);
    const items = Array.isArray(subtasks) ? subtasks.filter(Boolean) : [];
    if (settings.delegation_enabled === false) {
      return { ok: false, error: "delegation is disabled by settings" };
    }
    const maxDepth = Number(settings.delegation_max_depth ?? 1);
    const depth = delegationDepth(db, parentTask);
    if (depth >= maxDepth) {
      return { ok: false, error: `delegation depth limit reached (${depth}/${maxDepth})` };
    }
    if (items.length === 0) {
      return { ok: false, error: "delegate requires at least one subtask" };
    }
    const maxChildren = Number(settings.delegation_max_children_per_round ?? 5);
    if (items.length > maxChildren) {
      return { ok: false, error: `delegation requested ${items.length} subtasks, max is ${maxChildren}` };
    }
    if (detectSubtaskCycles(items)) {
      return { ok: false, error: "delegated subtasks form a dependency cycle" };
    }

    const titles = new Set();
    for (const [index, subtask] of items.entries()) {
      const title = String(subtask?.title || "").trim();
      if (!title) return { ok: false, error: `subtask ${index + 1} is missing a title` };
      if (titles.has(title)) return { ok: false, error: `duplicate subtask title: ${title}` };
      titles.add(title);

      const suggested = String(subtask?.suggested_agent || parentTask.owner_agent || "").trim();
      if (!suggested) return { ok: false, error: `subtask "${title}" has no owner agent` };
      const agent = enabledAgentExists(db, suggested) ? { name: suggested } : null;
      if (!agent) {
        return { ok: false, error: `subtask "${title}" suggested agent "${suggested}" was not found or is disabled` };
      }

      for (const dep of subtask.depends_on || []) {
        const depRef = String(dep || "").trim();
        if (!depRef) continue;
        if (depRef === title) return { ok: false, error: `subtask "${title}" cannot depend on itself` };
        if (items.some((candidate) => String(candidate?.title || "").trim() === depRef)) continue;
        if (!resolveTaskId(db, depRef)) {
          return { ok: false, error: `subtask "${title}" depends_on "${depRef}" did not resolve` };
        }
      }
    }

    return { ok: true, settings, subtasks: items };
  }

  function createDelegatedSubtasks(parentTask, runId, subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return [];

    const created = [];
    const byTitle = new Map();
    const rootTaskId = parentTask.root_task_id || parentTask.id;
    const now = Date.now();
    const warnings = [];

    const tx = db.transaction(() => {
      // Supersede prior delegation: drop old subtask edges so
      // maybeResumeWaitingParents only tracks the current round.
      db.prepare(
        "DELETE FROM task_edges WHERE parent_task_id = ? AND edge_type = 'subtask'",
      ).run(parentTask.id);

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        if (!subtask.title || typeof subtask.title !== "string") continue;
        const suggested = subtask.suggested_agent || parentTask.owner_agent;
        const agentName = enabledAgentExists(db, suggested) ? suggested : null;
        const childId = newTaskId();
        const taskKey = nextTaskKey(db);
        const required = subtask.required === false ? 0 : 1;
        const instructions = appendDelegationDoneCriteria(subtask.instructions || "", subtask);
        db.prepare(`
          INSERT INTO tasks
            (id, task_key, root_task_id, parent_task_id, delegated_by_run_id, delegated_to_agent,
             owner_agent, project_id, title, instructions, stage, run_policy, join_policy, subtask_order,
             required, reviewer_agent, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', ?, 'all_required', ?, ?, ?, ?, ?, ?)
        `).run(
          childId,
          taskKey,
          rootTaskId,
          parentTask.id,
          runId,
          agentName,
          agentName,
          parentTask.project_id || null,
          subtask.title.trim(),
          instructions,
          parentTask.run_policy || "manual",
          index,
          required,
          parentTask.reviewer_agent || null,
          JSON.stringify(["delegated"]),
          now,
          now,
        );
        db.prepare(`
          INSERT INTO task_edges
            (parent_task_id, child_task_id, edge_type, required, created_by_run_id, created_at)
          VALUES (?, ?, 'subtask', ?, ?, ?)
        `).run(parentTask.id, childId, required, runId, now);
        created.push({ id: childId, taskKey, title: subtask.title.trim(), required: !!required, agentName });
        byTitle.set(subtask.title.trim(), childId);
      }

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        const child = created[index];
        if (!child) continue;
        for (const dep of subtask.depends_on || []) {
          const trimmed = (dep || "").trim?.() || dep;
          let depId = byTitle.get(trimmed);
          if (!depId) {
            // Allow referring to an existing task by id (sibling created in
            // this batch already covered above; this handles cross-batch).
            depId = resolveTaskId(db, trimmed);
          }
          if (!depId || depId === child.id) {
            warnings.push(`Subtask "${subtask.title || "?"}": depends_on "${dep}" did not resolve and was dropped.`);
            continue;
          }
          insertDependency(db, child.id, depId, now);
        }
      }
    });
    tx();

    if (warnings.length > 0) {
      postSystemComment(parentTask.id, `Delegation warnings:\n- ${warnings.join("\n- ")}`);
    }
    if (created.length > 0) {
      const lines = created.map((child) => `- ${child.taskKey}: ${child.title} (${child.agentName || "unassigned"}${child.required ? ", required" : ", optional"})`);
      postSystemComment(parentTask.id, `Delegated ${created.length} subtask${created.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    }

    for (const child of created) broker.broadcast("global", { type: "task_created", id: child.id });
    return created;
  }

  function delegatedChildRows(parentTaskId) {
    return db.prepare(`
      SELECT t.id
      FROM task_edges e
      JOIN tasks t ON t.id = e.child_task_id
      WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
      ORDER BY t.subtask_order ASC, t.created_at ASC
    `).all(parentTaskId);
  }

  function hasTaskRuns(taskId) {
    return !!db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? LIMIT 1").get(taskId);
  }

  function scheduleDelegatedChildren(parentTaskId, children = null) {
    const settings = readSettings(db);
    if (settings.delegation_auto_run_children === false) return;
    const candidates = children || delegatedChildRows(parentTaskId);
    const childIds = new Set(delegatedChildRows(parentTaskId).map((child) => child.id));
    const activeCount = [...childIds].filter((id) => active.has(id) || pendingStarts.has(id)).length;
    const limit = Math.max(1, Number(settings.delegation_max_parallel_children ?? candidates.length));
    const slots = Math.max(0, limit - activeCount);
    if (slots <= 0) return;
    let scheduled = 0;
    for (const child of candidates) {
      if (scheduled >= slots) break;
      if (active.has(child.id) || pendingStarts.has(child.id)) continue;
      if (hasTaskRuns(child.id)) continue;
      if (!canAutoStart(child.id)) continue;
      scheduled += 1;
      scheduleAutoStart(child.id, (err) => {
        logger?.warn?.({ err, childId: child.id }, "delegated child auto-run failed");
        annotateTaskFailure(child.id, { message: `Auto-start failed: ${err.message}`, failureKind: "spawn", retryStage: "execute" });
      });
    }
  }

  function maybeRunDelegatedChildren(parentTaskId, children) {
    scheduleDelegatedChildren(parentTaskId, children);
  }

  function maybeRunMoreDelegatedSiblings(childTaskId) {
    const parents = db.prepare(`
      SELECT p.id
      FROM task_edges e
      JOIN tasks p ON p.id = e.parent_task_id
      WHERE e.child_task_id = ? AND e.edge_type = 'subtask'
    `).all(childTaskId);
    for (const parent of parents) {
      const row = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent.id);
      if (taskStage(row) === "awaiting_children") scheduleDelegatedChildren(parent.id);
    }
  }

  function maybeResumeWaitingParents(childTaskId) {
    maybeRunMoreDelegatedSiblings(childTaskId);
    resumeWaitingParents({
      db,
      childTaskId,
      applySideEffects,
      onParentReady: (parentId) => {
        scheduleAutoStart(parentId, (err) => {
          logger?.warn?.({ err, parentTaskId: parentId }, "parent resume run failed");
          annotateTaskFailure(parentId, { message: `Parent resume failed: ${err.message}`, failureKind: "spawn", retryStage: "execute" });
        });
      },
    });
  }

  function handleSuccessfulExit(taskId, runId, res, task, run) {
    const stage = run.stage || taskStage(task);
    const mode = run.mode || modeForStage(stage);
    const agentName = run.agent_name;
    const result = res.worklabResult || buildFallbackResult({ stage, mode, res });

    if (!result) {
      handleFailedExit(taskId, runId, {
        ...res,
        error: "invalid worklab_result",
        processStatus: "failed",
        failureKind: "invalid_result",
      }, task, run);
      return;
    }

    if (result.decision === "delegate") {
      const validation = validateDelegationRequest(task, result.subtasks);
      if (!validation.ok) {
        handleFailedExit(taskId, runId, {
          ...res,
          error: `invalid delegation: ${validation.error}`,
          processStatus: "failed",
          failureKind: "invalid_result",
        }, task, run);
        return;
      }
      result.subtasks = validation.subtasks;
    }

    updateRunResult(runId, result);
    postAgentFinalComment(taskId, agentName, result, res.finalText, {
      task,
      run,
      runId,
      stage,
      events: res.events,
    });

    const next = nextStage(taskStage(task), {
      type: "run_succeeded",
      stage,
      result,
      reviewerAgent: stage === "review" ? null : (task.reviewer_agent || null),
      rejectionCount: task.rejection_streak || 0,
      maxRejections: maxRejectionLimit(),
    });
    const errorSideEffect = next.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) {
      logger?.error?.({ taskId, runId, message: errorSideEffect.message }, "illegal transition on run exit");
      annotateTaskFailure(taskId, {
        message: errorSideEffect.message,
        failureKind: "invalid_result",
        retryStage: stage,
      });
      return;
    }

    let sideEffects = next.sideEffects;
    if (stage === "plan") {
      const planSideEffect = planBodySideEffect(runId, agentName, result, res.finalText);
      if (planSideEffect) sideEffects = [planSideEffect, ...sideEffects];
    }

    applySideEffects(taskId, sideEffects, taskStage(task), next.stage);

    const delegated = next.sideEffects.find((sideEffect) => sideEffect.type === "create_subtasks");
    if (delegated) {
      const children = createDelegatedSubtasks({ ...task, stage: next.stage }, runId, delegated.subtasks);
      maybeRunDelegatedChildren(taskId, children);
    }

    if (next.stage === "done" || next.stage === "blocked") maybeResumeWaitingParents(taskId);
    if (next.stage === "done") maybeAutoStartDependents(taskId);
    if (["plan", "execute", "review"].includes(next.stage)) maybeAutoStartTask(taskId);
  }

  function handleFailedExit(taskId, runId, res, task, run) {
    const processStatus = runProcessStatus(res);
    const stage = run.stage || taskStage(task);
    const failureKind = res.failureKind || res.failure_kind || (processStatus === "cancelled" ? "cancelled" : "spawn");
    const eventType = processStatus === "cancelled"
      ? "run_cancelled"
      : processStatus === "abandoned"
        ? "run_abandoned"
        : "run_failed";
    const sm = nextStage(taskStage(task), {
      type: eventType,
      retryStage: stage,
      failureKind,
      message: res.error || (processStatus === "cancelled" ? "Run cancelled." : "run failed"),
      failureCount: task.failure_count || 0,
      maxFailures: maxFailureLimit(),
      cancelInitiator: res.cancelInitiator || res.cancel_initiator || null,
      cancelReason: res.cancelReason || res.cancel_reason || null,
    });
    applySideEffects(taskId, sm.sideEffects, taskStage(task), sm.stage);
    db.prepare(
      `UPDATE task_runs
       SET failure_kind = COALESCE(failure_kind, ?), retry_stage = COALESCE(retry_stage, ?)
       WHERE id = ?`,
    ).run(failureKind, stage, runId);
    maybeStartRecoveryContinuation({
      taskId,
      runId,
      res,
      task,
      run,
      stage,
      failureKind,
      processStatus,
      nextStageValue: sm.stage,
    });
    // Wake parents on every child terminal-ish exit. maybeResumeWaitingParents
    // is idempotent and per-child only fires when the child is `blocked` or
    // all required children are `done`, so this is safe even when the child
    // remains at `execute` after a cancel.
    maybeResumeWaitingParents(taskId);
  }

  function onWorkerExit(taskId, runId, res) {
    const entry = active.get(taskId);
    if (entry?.runId === runId) active.delete(taskId);
    activeByRunId.delete(runId);
    const task = getTaskById(db, taskId);
    if (!task) return;
    const run = getRunById(db, runId);
    if (!run) return;

    const processStatus = runProcessStatus(res);
    if (processStatus === "succeeded" || res.status === "complete") {
      handleSuccessfulExit(taskId, runId, res, task, run);
    } else {
      handleFailedExit(taskId, runId, res, task, run);
    }
    recordPerRunBudgetOverage({ runId, agentName: run.agent_name, costUsd: res.costUsd ?? res.cost_usd });

    const endedEvent = buildRunLifecycleEvent(db, "run_ended", runId, { taskId });
    broker.broadcast("global", endedEvent);
    events?.emit?.("run:ended", endedEvent);
  }

  function cancel(taskId, options = {}) {
    const entry = active.get(taskId);
    if (!entry) return false;
    entry.handle.cancel({
      initiator: options.initiator || "user",
      reason: options.reason || null,
    });
    return true;
  }

  function getRunLiveInputState(runId) {
    const run = getRunCoreFields(db, runId);
    if (!run) return { supported: false, active: false, reason: "not_found" };
    if (!supportsLiveInputProvider(run.provider_kind)) {
      return { supported: false, active: false, reason: "unsupported_provider" };
    }
    const entry = activeByRunId.get(runId);
    return {
      supported: true,
      active: !!entry,
      reason: entry ? null : "not_active",
    };
  }

  async function sendRunMessage(runId, message) {
    const entry = activeByRunId.get(runId);
    if (!entry) {
      return { ok: false, code: "run_not_active", message: "run is not active" };
    }
    if (!supportsLiveInputProvider(entry.providerKind)) {
      return { ok: false, code: "live_input_unsupported", message: "live input is not supported for this provider" };
    }
    if (typeof entry.handle?.sendLiveMessage !== "function") {
      return { ok: false, code: "live_input_unavailable", message: "worker does not accept live input" };
    }
    return entry.handle.sendLiveMessage(message);
  }

  async function shutdown() {
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
    pendingStarts.clear();
    const promises = [];
    for (const entry of active.values()) {
      entry.handle.cancel({
        initiator: "coordinator_shutdown",
        reason: "coordinator stopping",
      });
      promises.push(entry.handle.done);
    }
    await Promise.allSettled(promises);
  }

  return {
    handleRunRequested,
    cancel,
    shutdown,
    isActive: (taskId) => active.has(taskId),
    isRunActive: (runId) => activeByRunId.has(runId),
    getRunLiveInputState,
    sendRunMessage,
    maybeAutoStart: maybeAutoStartTask,
    maybeAutoStartDependents,
  };
}
