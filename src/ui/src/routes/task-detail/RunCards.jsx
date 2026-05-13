import { useEffect, useMemo, useRef } from "preact/hooks";

import { EventTimeline } from "../../components/EventTimeline.jsx";
import { FileTree } from "../../components/FileTree.jsx";
import { Icon } from "../../components/Icon.jsx";
import { AgentReferenceText } from "../../components/AgentLink.jsx";
import { RunHistoryNotice } from "../../components/RunHistoryNotice.jsx";
import { InlineHead, SectionGroup, SectionStack, Toolbar } from "../../components/layout/index.js";
import { StatusPill } from "../../components/primitives/StatusPill.jsx";
import { useRunStream } from "../../lib/useRunStream.js";
import { formatRunSummaryTitle, runMetricItems, runResultPreview } from "../../lib/runFormatting.js";
import {
  aggregateRunArtifacts,
  artifactDeltaLabel,
  buildRunArtifactTree,
  extractRunArtifacts,
  groupRunArtifacts,
  normalizeStoredArtifacts,
  runArtifactSummary,
} from "../../lib/runArtifacts.js";
import { formatActivityTime, formatDate } from "./format.js";

function RunMetric({ label, value }) {
  const key = String(label || "").toLowerCase().replace(/\s+/g, "-");
  return (
    <span class={`run-metric run-metric-${key}`}>
      <span class="run-metric-label">{label}</span>
      <span class="run-metric-value">{value}</span>
    </span>
  );
}

function RunWarningsList({ warnings, agents = [] }) {
  if (!Array.isArray(warnings) || !warnings.length) return null;
  return (
    <ul class="run-warnings-list">
      {warnings.map((w, idx) => (
        <li key={idx} class={`run-warning-item run-warning-${(w.kind || "runtime").replace(/[^a-z0-9_-]/gi, "_")}`}>
          <span class="run-warning-kind">{w.kind || "runtime"}</span>
          {w.source && <span class="run-warning-source">{w.source}</span>}
          <span class="run-warning-message"><AgentReferenceText text={w.message || ""} agents={agents} /></span>
        </li>
      ))}
    </ul>
  );
}

export function runBudgetBadgeState(run, warnings = run?.warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return null;
  const exceeded = warnings.find((w) => w?.kind === "budget_exceeded");
  const soft = warnings.find((w) => w?.kind === "budget_soft");
  const active = exceeded || soft;
  if (!active) return null;
  const isCancel = !!exceeded && (
    run?.failure_kind === "budget_exceeded"
    || run?.cancel_initiator === "budget"
    || run?.diagnostics?.failure_kind === "budget_exceeded"
    || run?.diagnostics?.cancel_initiator === "budget"
    || active?.diagnostics?.tier === "hard"
    || /^Run cancelled:/i.test(active?.message || "")
  );
  return {
    tone: isCancel ? "run-warning-budget-hard" : "run-warning-budget-soft",
    label: isCancel ? "Budget cancel" : exceeded ? "Budget over" : "Budget soft",
    title: active.message || "",
  };
}

function RunBudgetBadge({ run, warnings }) {
  const badge = runBudgetBadgeState(run, warnings);
  if (!badge) return null;
  return (
    <span
      class={`run-warning-badge ${badge.tone}`}
      title={badge.title}
    >
      {badge.label}
    </span>
  );
}

function RunCancellationNote({ run }) {
  if (!run?.cancel_initiator) return null;
  const reason = run.cancel_reason ? `: ${run.cancel_reason}` : "";
  return (
    <div class="run-cancel-note">
      Cancel initiated by <code>{run.cancel_initiator}</code>{reason}
    </div>
  );
}

function shortSha(value) {
  return value ? String(value).slice(0, 7) : null;
}

export function worktreeDisplayState(run) {
  if (run?.workspace_mode !== "worktree") return null;
  const worktree = run.worktree || {};
  const status = worktree.last_reconcile_status || worktree.status || null;
  const branch = worktree.branch || null;
  const branchHead = shortSha(worktree.branch_head);
  const before = shortSha(worktree.source_head_before || worktree.previous_source_head);
  const after = shortSha(worktree.source_head_after || worktree.source_head);
  const paused = [
    "blocked_dirty_source",
    "blocked_uncommitted_worktree",
    "merge_conflict",
    "source_moved",
    "missing_worktree_metadata",
    "missing_worktree",
    "worktree_merge_blocked",
  ].includes(status);
  let label = "Worktree";
  let tone = "neutral";
  if (status === "merged") {
    label = "Merged";
    tone = "success";
  } else if (status === "already_up_to_date") {
    label = "Already in source";
    tone = "success";
  } else if (paused) {
    label = "Merge paused";
    tone = "warn";
  }
  return {
    label,
    tone,
    status,
    branch,
    branchHead,
    source: run.source_workdir || worktree.source_workdir || null,
    transition: before && after ? `${before} -> ${after}` : null,
    message: worktree.message || null,
  };
}

function RunWorktreeNote({ run }) {
  const state = worktreeDisplayState(run);
  if (!state) return null;
  return (
    <div class="run-worktree-note">
      <span class="run-worktree-note-label">Worktree</span>
      <span>{state.label}</span>
      {state.transition && <code>{state.transition}</code>}
      {state.branch && <code>{state.branch}</code>}
      {state.branchHead && <code>{state.branchHead}</code>}
      {state.source && <span class="truncate">Source: {state.source}</span>}
      {state.message && <span class="truncate">{state.message}</span>}
    </div>
  );
}

function RunDiagnosticsDisclosure({ run }) {
  const diag = run?.diagnostics;
  if (!diag || typeof diag !== "object") return null;
  return (
    <details class="run-diagnostics">
      <summary>Run diagnostics</summary>
      <pre>{JSON.stringify(diag, null, 2)}</pre>
    </details>
  );
}

const VERIFICATION_KIND_TONES = {
  test: "verification-pass",
  build: "verification-pass",
  lint: "verification-pass",
  manual_check: "verification-manual",
  screenshot: "verification-manual",
  n_a: "verification-na",
};

function looksLikeFailure(status) {
  const text = String(status || "").trim().toLowerCase();
  if (!text) return false;
  if (text === "0" || text === "ok" || text === "pass" || text === "passed" || text === "success") return false;
  if (text === "n/a" || text === "skipped") return false;
  return /\b(fail|error|reject|denied|timeout)\b/.test(text) || /^[1-9]/.test(text);
}

function RunVerificationPanel({ run }) {
  if (run?.mode !== "review") return null;
  const evidence = Array.isArray(run?.result?.verification_evidence)
    ? run.result.verification_evidence.map((row, index) => ({ row, index })).filter((entry) => entry.row)
    : [];
  if (evidence.length === 0) return null;
  const crossCheckRows = Array.isArray(run?.diagnostics?.verification_cross_check?.rows)
    ? run.diagnostics.verification_cross_check.rows
    : [];
  const crossCheckByIndex = new Map(crossCheckRows.map((row) => [row.evidence_index, row]));
  return (
    <details class="run-diagnostics run-verification" open>
      <summary>Verification ({evidence.length})</summary>
      <ul class="run-verification-list">
        {evidence.map(({ row, index }) => {
          const check = crossCheckByIndex.get(index);
          const failed = looksLikeFailure(row.exit_code_or_status);
          const unmatched = check && !check.match_source;
          const tone = failed || unmatched ? "verification-fail" : (VERIFICATION_KIND_TONES[row.kind] || "verification-pass");
          return (
            <li key={index} class={`run-verification-item ${tone}`}>
              <InlineHead class="run-verification-head">
                <span class="run-verification-kind">{row.kind}</span>
                {row.command_or_url && <code class="run-verification-cmd">{row.command_or_url}</code>}
                {row.exit_code_or_status && <span class="run-verification-status">{row.exit_code_or_status}</span>}
                {check?.match_source && <span class="run-verification-status">{check.match_source}</span>}
              </InlineHead>
              {row.snippet && <pre class="run-verification-snippet">{row.snippet}</pre>}
              {row.reason && <div class="run-verification-reason">{row.reason}</div>}
              {check && <div class="run-verification-reason">{check.match_source ? `Matched ${check.matched_tool_call || ""}: ${check.reason || check.match_source}` : `Unmatched: ${check.reason || "No matching logged tool call."}`}</div>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function RunEconomicsPanel({ run }) {
  const overheadTokens = Number(run?.first_turn_overhead_tokens);
  const inputTokens = Number(run?.first_turn_input_tokens);
  const diag = run?.diagnostics || {};
  const truncatedCount = Number(diag.tool_results_truncated) || 0;
  const prunedCount = Number(diag.tool_outputs_pruned) || 0;
  const compactionCount = Number(diag.context_compactions) || 0;
  const billed = Number(run?.log?.input_tokens) || 0;
  const cacheRead = Number(run?.log?.cache_read_tokens) || 0;
  const haveOverhead = Number.isFinite(overheadTokens) && overheadTokens > 0;
  const haveInput = Number.isFinite(inputTokens) && inputTokens > 0;
  if (!haveOverhead && !haveInput && !truncatedCount && !prunedCount && !compactionCount) return null;
  const overheadShare = haveOverhead && haveInput ? Math.round((overheadTokens / inputTokens) * 100) : null;
  return (
    <details class="run-diagnostics run-economics">
      <summary>Run economics</summary>
      <Toolbar class="run-economics-grid" align="start">
        {haveInput && <RunMetric label="Turn 1 input" value={`${inputTokens.toLocaleString()} tok`} />}
        {haveOverhead && (
          <RunMetric
            label="Turn 1 system"
            value={overheadShare != null ? `${overheadTokens.toLocaleString()} tok (${overheadShare}%)` : `${overheadTokens.toLocaleString()} tok`}
          />
        )}
        {billed > 0 && <RunMetric label="Billed input" value={`${billed.toLocaleString()} tok`} />}
        {cacheRead > 0 && <RunMetric label="Cache hit" value={`${cacheRead.toLocaleString()} tok`} />}
        {truncatedCount > 0 && <RunMetric label="Truncated" value={`${truncatedCount}`} />}
        {prunedCount > 0 && <RunMetric label="Pruned" value={`${prunedCount}`} />}
        {compactionCount > 0 && <RunMetric label="Compactions" value={`${compactionCount}`} />}
      </Toolbar>
    </details>
  );
}

function shortRunId(id) {
  return id ? String(id).slice(-6) : "";
}

function navigateToRun(event, runId) {
  if (!runId) return;
  event.preventDefault();
  const hash = window.location.hash || "";
  const [pathPart] = hash.replace(/^#/, "").split("?");
  const next = `#${pathPart}?run=${encodeURIComponent(runId)}`;
  if (window.location.hash !== next) window.location.hash = next;
}

function RunContinuationLinks({ run }) {
  const continuationDepth = Number(run?.continuation?.depth || 0);
  const rootId = run?.continuation?.root_run_id;
  const childId = run?.continuation_child_id;
  if (!childId && continuationDepth === 0) return null;
  return (
    <div class="run-continuation-links">
      {continuationDepth > 0 && rootId && (
        <span class="run-continuation-link">
          Continuation #{continuationDepth} of run{" "}
          <a
            href={`#?run=${encodeURIComponent(rootId)}`}
            onClick={(event) => navigateToRun(event, rootId)}
          >
            #{shortRunId(rootId)}
          </a>
        </span>
      )}
      {childId && (
        <span class="run-continuation-link">
          Continued as run{" "}
          <a
            href={`#?run=${encodeURIComponent(childId)}`}
            onClick={(event) => navigateToRun(event, childId)}
          >
            #{shortRunId(childId)}
          </a>
        </span>
      )}
    </div>
  );
}

function RunFailureDetails({ run, agents = [] }) {
  const processStatus = run?.process_status || run?.status;
  const isFailed = processStatus === "failed" || processStatus === "abandoned" || run?.status === "error";
  if (!isFailed) return null;
  const failureKind = run?.failure_kind;
  const subkind = run?.diagnostics?.provider_error_subkind;
  const errorDetails = run?.error_details || {};
  const lastText = typeof errorDetails.last_text_excerpt === "string"
    ? errorDetails.last_text_excerpt.trim()
    : "";
  const lastTool = typeof errorDetails.last_tool_name === "string"
    ? errorDetails.last_tool_name.trim()
    : "";
  const cancelInitiator = typeof run?.cancel_initiator === "string" ? run.cancel_initiator.trim() : "";
  const cancelReason = typeof run?.cancel_reason === "string" ? run.cancel_reason.trim() : "";
  const stderrTail = typeof run?.diagnostics?.stderr_tail === "string"
    ? run.diagnostics.stderr_tail
    : "";
  const stderrTailTrimmed = stderrTail.trim();
  const hasAny = Boolean(
    failureKind || subkind || lastText || lastTool || cancelInitiator || cancelReason || stderrTailTrimmed,
  );
  if (!hasAny) return null;
  const stderrTruncated = stderrTailTrimmed.length > 400
    ? stderrTailTrimmed.slice(0, 400)
    : stderrTailTrimmed;
  const stderrHasMore = stderrTailTrimmed.length > 400;
  return (
    <dl class="run-failure-details">
      {failureKind && (
        <div class="run-failure-row">
          <dt>Failure kind</dt>
          <dd><code>{failureKind}</code></dd>
        </div>
      )}
      {subkind && (
        <div class="run-failure-row">
          <dt>Provider subkind</dt>
          <dd><code>{subkind}</code></dd>
        </div>
      )}
      {(cancelInitiator || cancelReason) && (
        <div class="run-failure-row">
          <dt>Cancel</dt>
          <dd>
            {cancelInitiator && <code>{cancelInitiator}</code>}
            {cancelInitiator && cancelReason ? ": " : null}
            <AgentReferenceText text={cancelReason} agents={agents} />
          </dd>
        </div>
      )}
      {lastText && (
        <div class="run-failure-row">
          <dt>Last assistant text</dt>
          <dd class="run-failure-snippet"><AgentReferenceText text={lastText} agents={agents} /></dd>
        </div>
      )}
      {lastTool && (
        <div class="run-failure-row">
          <dt>Last tool</dt>
          <dd><code>{lastTool}</code></dd>
        </div>
      )}
      {stderrTailTrimmed && (
        <div class="run-failure-row">
          <dt>stderr tail</dt>
          <dd>
            <pre class="run-failure-stderr">{stderrTruncated}</pre>
            {stderrHasMore && (
              <details class="run-failure-stderr-full">
                <summary>Show more</summary>
                <pre class="run-failure-stderr">{stderrTailTrimmed}</pre>
              </details>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

export function RunCard({ run, expanded, highlighted, onToggle, subscribe, agents = [] }) {
  const live = Boolean(subscribe);
  const runStream = useRunStream(expanded || subscribe ? run?.id : null, {
    subscribe,
    initialEventLimit: live ? 10 : 200,
    maxEvents: live ? 10 : 200,
  });
  const fullHistoryRequestedRef = useRef(null);
  const { events, loading } = runStream;
  const metrics = runMetricItems(run);
  const resultPreview = runResultPreview(run);
  const startedAt = formatDate(run.started_at);
  const shortStartedAt = formatActivityTime(run.started_at);
  const title = formatRunSummaryTitle(run);
  const processStatus = run.process_status || run.status;
  const warningLabel = processStatus === "succeeded" && Number(run.log?.num_turns) === 0
    ? "No final text"
    : null;
  const warnings = Array.isArray(run.warnings) ? run.warnings : [];
  const worktreeState = worktreeDisplayState(run);
  useEffect(() => {
    if (!expanded || live || !run?.id || loading) return;
    if (!runStream.eventsTruncated || runStream.fullHistoryLoaded) return;
    if (fullHistoryRequestedRef.current === run.id) return;
    fullHistoryRequestedRef.current = run.id;
    runStream.loadFullHistory();
  }, [expanded, live, loading, run?.id, runStream.eventsTruncated, runStream.fullHistoryLoaded]);
  return (
    <details
      open={expanded}
      onToggle={(e) => onToggle?.(run.id, e.currentTarget.open)}
      class={`run-card${expanded ? " expanded" : ""}${highlighted ? " highlighted" : ""}`}
    >
      <summary class="run-card-summary">
        <div class="run-summary">
          <div class="run-summary-main">
            {resultPreview.hasResult ? (
              <div class="run-summary-result">
                <InlineHead class="run-summary-result-head">
                  {resultPreview.decision && (
                    <span class={`run-result-decision ${resultPreview.tone || ""}`.trim()}>
                      {resultPreview.decision}
                    </span>
                  )}
                  {resultPreview.summary && <span class="run-result-summary"><AgentReferenceText text={resultPreview.summary} agents={agents} /></span>}
                  {!resultPreview.summary && <span class="run-result-summary">Result recorded</span>}
                  {run.automation_trigger_type && (
                    <span class="chip chip-trigger">
                      <Icon name="clock" size={10} /> Scheduled
                    </span>
                  )}
                  {warningLabel && <span class="run-warning-badge">{warningLabel}</span>}
                  {warnings.length > 0 && (
                    <span class="run-warning-badge run-warning-count" title={`${warnings.length} runtime warning${warnings.length === 1 ? "" : "s"}`}>
                      ⚠ {warnings.length}
                    </span>
                  )}
                  <RunBudgetBadge run={run} warnings={warnings} />
                  {worktreeState && (
                    <span class="run-warning-badge" title={worktreeState.message || worktreeState.source || undefined}>{worktreeState.label}</span>
                  )}
                  {run.cancel_initiator && (
                    <span class="run-warning-badge run-cancel-chip" title={run.cancel_reason || run.cancel_initiator}>
                      {run.cancel_initiator}
                    </span>
                  )}
                </InlineHead>
                {resultPreview.details && <div class="run-result-details"><AgentReferenceText text={resultPreview.details} agents={agents} /></div>}
              </div>
            ) : (
              <div class="run-summary-status">
                <StatusPill status={processStatus} size="sm" />
                {run.automation_trigger_type && (
                  <span class="chip chip-trigger">
                    <Icon name="clock" size={10} /> Scheduled
                  </span>
                )}
                <span class="run-summary-title" title={startedAt || undefined}>{title}</span>
                {warningLabel && <span class="run-warning-badge">{warningLabel}</span>}
                {warnings.length > 0 && (
                  <span class="run-warning-badge run-warning-count">⚠ {warnings.length}</span>
                )}
                <RunBudgetBadge run={run} warnings={warnings} />
                {worktreeState && (
                  <span class="run-warning-badge" title={worktreeState.message || worktreeState.source || undefined}>{worktreeState.label}</span>
                )}
                {run.cancel_initiator && (
                  <span class="run-warning-badge run-cancel-chip">{run.cancel_initiator}</span>
                )}
              </div>
            )}
          </div>
          {metrics.length > 0 && (
            <div class="run-summary-metrics" aria-label="Run metrics">
              {metrics.map(([label, value]) => <RunMetric key={label} label={label} value={value} />)}
            </div>
          )}
          <div class="run-summary-side">
            {shortStartedAt && <span class="run-summary-time" title={startedAt || undefined}>{shortStartedAt}</span>}
            <span>{expanded ? "Collapse" : "Details"}</span>
            <Icon name="chevron-down" size={14} class="run-summary-chevron" />
          </div>
        </div>
      </summary>
      {run.raw_output_path && (
        <Toolbar class="run-card-actions">
          <a href={`/api/runs/${encodeURIComponent(run.id)}/raw-log`} target="_blank" rel="noreferrer">
            Raw log
          </a>
        </Toolbar>
      )}
      <RunCancellationNote run={run} />
      <RunWorktreeNote run={run} />
      <RunWarningsList warnings={warnings} agents={agents} />
      <RunContinuationLinks run={run} />
      <RunFailureDetails run={run} agents={agents} />
      <RunVerificationPanel run={run} />
      <RunEconomicsPanel run={run} />
      <RunDiagnosticsDisclosure run={run} />
      <RunHistoryNotice
        eventCount={runStream.eventCount}
        visibleCount={events.length}
        eventsTruncated={runStream.eventsTruncated}
        fullHistoryLoaded={runStream.fullHistoryLoaded}
        loading={loading}
        onLoadFullHistory={runStream.loadFullHistory}
      />
      <div class="run-card-events">
        {loading && events.length === 0 ? (
          <div class="run-card-events-loading">Loading events…</div>
        ) : (
          <EventTimeline events={events} streaming={processStatus === "running"} />
        )}
      </div>
    </details>
  );
}

function taskArtifactsTitle(task, runningRun) {
  const summary = task?.artifact_summary || {};
  const runCount = Number(summary.run_count || 0);
  const parts = ["Task total"];
  if (runCount > 0) parts.push(`${runCount} run${runCount === 1 ? "" : "s"}`);
  if (runningRun) parts.push("live run included");
  return parts.join(" · ");
}

function artifactSources(artifact = {}) {
  return new Set([
    artifact.source,
    ...(Array.isArray(artifact.sources) ? artifact.sources : []),
  ].filter(Boolean));
}

function isEditedArtifact(artifact = {}) {
  const sources = artifactSources(artifact);
  return artifact.artifact_type === "code_change" || sources.has("file_edit");
}

const OUTPUT_ARTIFACT_RANK = {
  qa_output: 1,
  generated_output: 2,
  git_commit: 3,
  scratch: 4,
};

export function editedRunArtifactsForDisplay(artifacts = []) {
  return normalizeStoredArtifacts(artifacts).filter(isEditedArtifact);
}

export function outputRunArtifactsForDisplay(artifacts = []) {
  return normalizeStoredArtifacts(artifacts)
    .filter((artifact) => !isEditedArtifact(artifact))
    .sort((left, right) => {
      const rank = (OUTPUT_ARTIFACT_RANK[left.artifact_type] || 99) - (OUTPUT_ARTIFACT_RANK[right.artifact_type] || 99);
      if (rank) return rank;
      return String(left.display_path || left.path).localeCompare(String(right.display_path || right.path));
    });
}

export function runArtifactMetaText(node = {}) {
  if (node.type && node.type !== "file") return "";
  const delta = artifactDeltaLabel(node);
  if (delta) return delta;
  if (node.status === "in_progress" || node.status === "running") return "pending";
  if (node.event_count > 1) return `${node.event_count} edits`;
  if (node.artifact_type === "qa_output") return "qa";
  if (node.artifact_type === "git_commit") return "commit";
  return "";
}

function RunArtifactMeta({ node }) {
  if (node.type !== "file") return null;
  const text = runArtifactMetaText(node);
  if (!text) return null;
  const tone = text.startsWith("+")
    ? "delta"
    : text === "pending" ? "pending" : "muted";
  return <span class={`run-artifact-meta ${tone}`}>{text}</span>;
}

export function RunArtifactsSection({ task, runningRun, streamState = null }) {
  const isStreaming = Boolean(runningRun);
  const fallbackStream = useRunStream(streamState ? null : runningRun?.id, { subscribe: isStreaming });
  const effectiveStream = streamState || fallbackStream;
  const events = effectiveStream.events || [];
  const loading = effectiveStream.loading;
  const liveArtifacts = useMemo(() => {
    if (Array.isArray(effectiveStream.liveArtifacts) && effectiveStream.liveArtifacts.length) {
      return effectiveStream.liveArtifacts;
    }
    return extractRunArtifacts(events);
  }, [effectiveStream.liveArtifacts, events]);
  const artifacts = useMemo(() => {
    const taskArtifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
    if (!liveArtifacts.length) return taskArtifacts;
    return aggregateRunArtifacts([
      { artifacts: taskArtifacts },
      { id: runningRun?.id || "running", started_at: runningRun?.started_at, artifacts: liveArtifacts },
    ]);
  }, [task?.artifacts, liveArtifacts, runningRun?.id, runningRun?.started_at]);
  const editedArtifacts = useMemo(() => editedRunArtifactsForDisplay(artifacts), [artifacts]);
  const outputArtifacts = useMemo(() => outputRunArtifactsForDisplay(artifacts), [artifacts]);
  const outputGroups = useMemo(() => groupRunArtifacts(outputArtifacts), [outputArtifacts]);
  const tree = useMemo(() => buildRunArtifactTree(editedArtifacts), [editedArtifacts]);
  const summary = useMemo(() => runArtifactSummary(editedArtifacts), [editedArtifacts]);
  const summaryLabel = summary.files > 0
    ? `${summary.files} file${summary.files === 1 ? "" : "s"}`
    : null;
  const lineLabel = summary.files > 0 && (summary.added_lines || summary.removed_lines)
    ? `+${summary.added_lines} -${summary.removed_lines}`
    : null;
  const emptyText = loading
    ? "Loading edited files..."
    : isStreaming
      ? "No edited files recorded yet."
      : "No edited files recorded.";

  if (!task) return null;
  return (
    <SectionGroup
      as="div"
      class="run-artifacts-section"
      label={<span class="all-caps">Edited files</span>}
      count={summaryLabel ? (
        <span class="run-artifacts-summary">
          <span>{summaryLabel}</span>
          {lineLabel && <span class="run-artifacts-lines">{lineLabel}</span>}
        </span>
      ) : null}
    >
      <div class="run-artifacts-context" title={task.id}>{taskArtifactsTitle(task, runningRun)}</div>
      <FileTree
        files={tree}
        ariaLabel="Edited files"
        emptyText={emptyText}
        renderMeta={(node) => <RunArtifactMeta node={node} />}
        getNodeClass={(node) => node.type === "file" && (node.status === "in_progress" || node.status === "running") ? "is-pending" : ""}
      />
      {outputGroups.length > 0 && (
        <details class="run-artifact-outputs">
          <summary>Run outputs · {outputArtifacts.length}</summary>
          <SectionStack class="run-artifact-groups">
            {outputGroups.map((group) => (
              <SectionGroup
                class="run-artifact-group"
                key={group.id}
                label={group.label}
                count={group.summary.files}
              >
                <FileTree
                  files={group.tree}
                  ariaLabel={`${group.label} artifacts`}
                  renderMeta={(node) => <RunArtifactMeta node={node} />}
                  getNodeClass={(node) => node.type === "file" && (node.status === "in_progress" || node.status === "running") ? "is-pending" : ""}
                />
              </SectionGroup>
            ))}
          </SectionStack>
        </details>
      )}
    </SectionGroup>
  );
}
