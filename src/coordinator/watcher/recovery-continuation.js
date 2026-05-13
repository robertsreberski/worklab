import { retryableProviderFailureInfo } from "@worklab/agent-runtime/ai/failure.js";
import { readSettings } from "../../core/settings.js";
import { agentForTaskStage } from "../../core/task-agents.js";
import { taskStage } from "../../core/task-side-effects.js";
import { effectiveTeamForTask } from "../../core/teams.js";
import { getTaskById } from "../../core/db/queries/tasks.js";
import {
  getRunTranscriptTail,
  overrideRunFailureKind,
} from "../../core/db/queries/runs.js";
import { checkBudget } from "./budget.js";
import { compactRecoveryRunSummary } from "./failure-classifier.js";
import { modeForStage, safeParseJson } from "./run-handler.js";

const PI_CODEX_WEBSOCKET_TRANSPORTS = new Set(["auto", "websocket", "websocket-cached"]);

function websocketTransportFallback(diagnostics = {}, settings = {}) {
  const errorDetails = diagnostics.error_details || {};
  const code = diagnostics.pi_error_code || errorDetails.pi_error_code || null;
  const transport = diagnostics.pi_transport
    || errorDetails.pi_transport
    || settings.agent_pi_codex_transport
    || null;
  if (code !== "websocket_error" || !PI_CODEX_WEBSOCKET_TRANSPORTS.has(transport)) return {};
  return {
    pi_transport_override: "sse",
    pi_transport_fallback_reason: "websocket_error",
  };
}

export function createRecoveryContinuation({
  db,
  logger,
  active,
  pendingStarts,
  recoveryTimers,
  spawnRun,
  postSystemComment,
  patchRunDiagnostics,
  applySideEffects,
  reviewSubjectRunIdFor,
}) {
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

  function continuationParentRun(run) {
    const diagnostics = safeParseJson(run?.diagnostics_json, {});
    const diagnosticParentId = diagnostics.continuation_of_run_id || null;
    if (diagnosticParentId) {
      return db.prepare("SELECT id, parent_run_id, mode, stage, diagnostics_json FROM task_runs WHERE id = ?").get(diagnosticParentId) || null;
    }
    if (!run?.parent_run_id) return null;
    const parent = db.prepare("SELECT id, parent_run_id, mode, stage, diagnostics_json FROM task_runs WHERE id = ?").get(run.parent_run_id);
    if (!parent) return null;
    const runMode = run.mode || null;
    const parentMode = parent.mode || null;
    const runStage = run.stage || runMode;
    const parentStage = parent.stage || parentMode;
    if (runMode && parentMode && runMode !== parentMode) return null;
    if (runStage && parentStage && runStage !== parentStage) return null;
    return parent;
  }

  function hasRecoveryContinuation(runId) {
    return Boolean(db.prepare(`
      SELECT id
      FROM task_runs
      WHERE parent_run_id = ?
         OR (CASE
           WHEN diagnostics_json IS NOT NULL AND json_valid(diagnostics_json)
           THEN json_extract(diagnostics_json, '$.continuation_of_run_id')
           ELSE NULL
         END) = ?
      LIMIT 1
    `).get(runId, runId));
  }

  function continuationLineage(run) {
    const seen = new Set();
    const lineage = [run.id];
    let parent = continuationParentRun(run);
    while (parent && !seen.has(parent.id) && lineage.length < 50) {
      seen.add(parent.id);
      lineage.push(parent.id);
      parent = continuationParentRun(parent);
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

  function warningKindSet(value) {
    const warnings = Array.isArray(value) ? value : [];
    return new Set(warnings.map((warning) => warning?.kind || warning?.warning_kind || warning?.warningKind).filter(Boolean));
  }

  function schemaCorrectionFailure({ failureKind, res, run }) {
    if (failureKind === "invalid_delegation") return true;
    if (failureKind !== "invalid_result") return false;
    if (res?.resultError) return true;
    const diagnostics = {
      ...safeParseJson(run?.diagnostics_json, {}),
      ...(res?.diagnostics || {}),
    };
    const errorDetails = diagnostics.error_details || {};
    if (
      errorDetails.structured_output_retry_exhausted
      || errorDetails.claude_error_subtype === "error_max_structured_output_retries"
      || diagnostics.claude_error_subtype === "error_max_structured_output_retries"
    ) {
      return true;
    }
    const kinds = warningKindSet([
      ...safeParseJson(run?.warnings_json, []),
      ...(Array.isArray(res?.warnings) ? res.warnings : []),
    ]);
    return kinds.has("worklab_result_validation")
      || kinds.has("review_result_parse")
      || kinds.has("unstructured_result_fallback");
  }

  function recoveryReason({ failureKind, res, run, settings }) {
    if (failureKind === "usage_limit") {
      return { reason: "usage_limit", providerInfo: null };
    }
    if (schemaCorrectionFailure({ failureKind, res, run })) {
      return { reason: "schema_correction", providerInfo: null };
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
    const errorDetails = diagnostics.error_details || {};
    const lastToolName = errorDetails.last_tool_name || diagnostics.last_tool_name || null;
    const hadPartialProgress = !!(errorDetails.had_partial_progress || diagnostics.had_partial_progress);
    if (hadPartialProgress && lastToolName === "journal_summary") {
      return {
        reason: "finalisation",
        providerInfo: {
          ...providerInfo,
          subkind: "terminated_after_completion",
        },
      };
    }
    return {
      reason: diagnostics.context_risk === "high" ? "provider_retryable_context_risk" : "provider_retryable",
      providerInfo,
    };
  }

  function maybeStartRecoveryContinuation({ taskId, runId, res, task, run, stage, failureKind, processStatus, nextStageValue }) {
    if (processStatus !== "failed") return null;
    if (!["plan", "execute", "review"].includes(stage)) return null;
    if (hasRecoveryContinuation(runId)) return null;
    const settings = readSettings(db);
    const recovery = recoveryReason({ failureKind, res, run, settings });
    if (!recovery) return null;
    const baseContinuationLimit = Number(settings.agent_recovery_continuation_limit ?? 3);
    const continuationLimit = recovery.reason === "schema_correction"
      ? Math.min(2, baseContinuationLimit)
      : recovery.reason === "finalisation"
        ? Math.min(1, baseContinuationLimit)
        : baseContinuationLimit;
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
      if (failureKind === "provider_unavailable") {
        const attempts = lineage.depth + 1;
        overrideRunFailureKind(db, runId, {
          failureKind: "provider_unavailable_exhausted",
          errorText: `Auto-recovery exhausted after ${attempts} attempts.`,
          details: `Auto-recovery exhausted after ${attempts} attempts.`,
        });
        const currentTask = getTaskById(db, taskId);
        const currentStage = taskStage(currentTask);
        applySideEffects(
          taskId,
          [{ type: "set_stage_reason", reason: "Provider repeatedly terminated; manual retry required." }],
          currentStage,
          currentStage,
        );
      }
      return null;
    }

    const agentName = run.agent_name || agentForTaskStage(task, stage);
    if (!agentName) return null;
    const mode = run.mode || modeForStage(stage);
    const reviewSubjectRunId = mode === "review" ? reviewSubjectRunIdFor(run, taskId) : null;
    if (mode === "review" && !reviewSubjectRunId) {
      postSystemComment(taskId, "Automatic continuation skipped: no execute run is available for review.");
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "missing_review_subject",
        continuation_reason: recovery.reason,
        continuation_depth: lineage.depth,
        continuation_limit: continuationLimit,
        continuation_root_run_id: lineage.rootRunId,
      });
      return null;
    }
    const continuationTeamId = effectiveTeamForTask(db, task);
    const budget = checkBudget({ db, agentName, teamId: continuationTeamId });
    if (!budget.ok) {
      postSystemComment(taskId, `Automatic continuation skipped: ${budget.message}`);
      return null;
    }

    const continuationStage = ["plan", "execute", "review"].includes(nextStageValue) ? nextStageValue : stage;
    const attempt = lineage.depth + 1;
    const delayMs = recovery.reason === "usage_limit"
      || recovery.reason === "schema_correction"
      || recovery.reason === "finalisation"
      ? 0
      : providerRecoveryDelay(settings, attempt);
    const resumeSnapshot = recovery.reason === "provider_retryable" || recovery.reason === "finalisation"
      ? loadResumeSnapshot(runId)
      : null;
    const summary = compactRecoveryRunSummary({
      runId,
      res,
      reason: recovery.reason === "usage_limit"
        || recovery.reason === "schema_correction"
        || recovery.reason === "finalisation"
        ? recovery.reason
        : "provider_retryable",
      providerInfo: recovery.providerInfo,
    });
    const diagnostics = {
      ...safeParseJson(run?.diagnostics_json, {}),
      ...(res?.diagnostics || {}),
    };
    const transportFallback = websocketTransportFallback(diagnostics, settings);
    const delegationRetryGuidance = failureKind === "invalid_delegation"
      ? [
          `The previous delegation request exceeded policy: ${diagnostics.delegation_validation_error || res?.error || "invalid delegation"}.`,
          diagnostics.delegation_max_children
            ? `The max children is ${diagnostics.delegation_max_children}. Return at most that many subtasks; merge adjacent subtasks owned by the same agent or touching the same files.`
            : "Return at most the configured max children; merge adjacent subtasks owned by the same agent or touching the same files.",
          "Preserve the original work by combining instructions, acceptance criteria, expected artifacts, and depends_on references inside the fewer subtasks.",
        ]
      : [];
    const heading = recovery.reason === "usage_limit"
      ? "Automatic continuation after context-window overflow."
      : recovery.reason === "schema_correction"
        ? "Automatic schema-correction continuation after malformed Worklab result."
      : recovery.reason === "finalisation"
        ? "Automatic finalisation continuation: prior run completed work but dropped before emitting the worklab.v2 envelope."
      : mode === "review"
        ? `Automatic review continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`
        : `Automatic continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`;
    const retryGuidance = recovery.reason === "schema_correction"
      ? [
          ...delegationRetryGuidance,
          "Return exactly one valid `worklab.v2` JSON object that preserves your prior decision.",
          "Escape double quotes inside strings, especially in `summary`, `details`, and `final_text`.",
          "Do not use XML, tool-call syntax, or `<parameter name=...>` tags; every field must be a top-level JSON property.",
          "Do not include markdown fences or prose before or after the JSON.",
          "Do not redo completed work; inspect the prior run log, workspace, journal, or KB entries only as needed to re-emit the envelope.",
        ]
      : recovery.reason === "finalisation"
      ? [
          "The previous run already completed the work — committed the changes, called `journal_summary`, and the workdir is clean — but the provider connection dropped before it could emit the worklab.v2 envelope.",
          "Do NOT redo the work. Inspect the workdir (`git status`, `git log -1`, the journal tail), confirm the work matches the task instructions, and emit a single `worklab.v2` JSON envelope reporting the existing commit hash.",
          "If the workdir is dirty or the work is incomplete, emit a `worklab.v2` envelope with `decision: \"pause\"` and pending_actions describing what's missing — do not start a fresh implementation.",
        ]
      : [
          "Continue from the current workspace state. Do not repeat completed work. Do not repeat broad repository scans such as `Glob **/*`; inspect targeted files only and avoid generated/vendor directories.",
        ];
    postSystemComment(taskId, [
      heading,
      delayMs > 0 ? `Retrying in ${Math.round(delayMs / 1000)} seconds.` : "",
      mode === "review" && reviewSubjectRunId ? `Retrying the review against execute run \`${reviewSubjectRunId}\`.` : "",
      "",
      summary,
      "",
      ...retryGuidance,
    ].filter(Boolean).join("\n").trim());
    applySideEffects(taskId, [
      { type: "clear_error_text" },
      { type: "set_stage_reason", reason: `continuing after ${recovery.reason}` },
      { type: "increment_lifetime_recovery_continuation_count" },
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
      ...transportFallback,
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
        stage: continuationStage,
        mode,
        agentName,
        parentRunId: mode === "review" ? reviewSubjectRunId : runId,
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
          ...transportFallback,
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

  return {
    continuationLineage,
    maybeStartRecoveryContinuation,
  };
}
