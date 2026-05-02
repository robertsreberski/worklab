import { useMemo } from "preact/hooks";

import { EventTimeline } from "../../components/EventTimeline.jsx";
import { FileTree } from "../../components/FileTree.jsx";
import { Icon } from "../../components/Icon.jsx";
import { AgentReferenceText } from "../../components/AgentLink.jsx";
import { RunHistoryNotice } from "../../components/RunHistoryNotice.jsx";
import { StatusPill } from "../../components/primitives/StatusPill.jsx";
import { useRunStream } from "../../lib/useRunStream.js";
import { formatRunSummaryTitle, runMetricItems, runResultPreview } from "../../lib/runFormatting.js";
import {
  aggregateRunArtifacts,
  artifactDeltaLabel,
  buildRunArtifactTree,
  extractRunArtifacts,
  groupRunArtifacts,
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
                <div class="run-summary-result-head">
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
                  {run.cancel_initiator && (
                    <span class="run-warning-badge run-cancel-chip" title={run.cancel_reason || run.cancel_initiator}>
                      {run.cancel_initiator}
                    </span>
                  )}
                </div>
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
        <div class="run-card-actions">
          <a href={`/api/runs/${run.id}/raw-log`} target="_blank" rel="noreferrer">
            Raw log
          </a>
        </div>
      )}
      <RunCancellationNote run={run} />
      <RunWarningsList warnings={warnings} agents={agents} />
      <RunContinuationLinks run={run} />
      <RunFailureDetails run={run} agents={agents} />
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

function RunArtifactMeta({ node }) {
  if (node.type !== "file") return null;
  if (node.unavailable_reason) {
    if (node.artifact_type === "qa_output") return <span class="run-artifact-meta muted">qa</span>;
    return <span class="run-artifact-meta muted">{node.unavailable_reason}</span>;
  }
  if (node.event_count > 1) {
    return <span class="run-artifact-meta muted">{node.event_count} edits</span>;
  }
  if (node.artifact_type === "git_commit") {
    return <span class="run-artifact-meta muted">commit</span>;
  }
  const delta = artifactDeltaLabel(node);
  if (delta) return <span class="run-artifact-meta delta">{delta}</span>;
  if (node.status === "in_progress" || node.status === "running") {
    return <span class="run-artifact-meta pending">pending</span>;
  }
  return null;
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
  const groups = useMemo(() => groupRunArtifacts(artifacts), [artifacts]);
  const tree = useMemo(() => buildRunArtifactTree(artifacts), [artifacts]);
  const summary = useMemo(() => runArtifactSummary(artifacts), [artifacts]);
  const summaryLabel = summary.files > 0
    ? `${summary.files} file${summary.files === 1 ? "" : "s"}`
    : null;
  const lineLabel = summary.files > 0 && (summary.added_lines || summary.removed_lines)
    ? `+${summary.added_lines} -${summary.removed_lines}`
    : null;
  const emptyText = loading
    ? "Loading artifacts..."
    : isStreaming
      ? "No artifacts recorded yet."
      : "No artifacts recorded.";

  if (!task) return null;
  return (
    <div class="run-artifacts-section">
      <div class="task-rail-section-head">
        <span class="all-caps">Artifacts</span>
        {summaryLabel && (
          <span class="run-artifacts-summary">
            <span>{summaryLabel}</span>
            {lineLabel && <span class="run-artifacts-lines">{lineLabel}</span>}
          </span>
        )}
      </div>
      <div class="run-artifacts-context" title={task.id}>{taskArtifactsTitle(task, runningRun)}</div>
      {groups.length ? (
        <div class="run-artifact-groups">
          {groups.map((group) => (
            <section class="run-artifact-group" key={group.id}>
              <div class="run-artifact-group-title">
                <span>{group.label}</span>
                <span>{group.summary.files}</span>
              </div>
              <FileTree
                files={group.tree}
                ariaLabel={`${group.label} artifacts`}
                renderMeta={(node) => <RunArtifactMeta node={node} />}
                getNodeClass={(node) => node.type === "file" && (node.status === "in_progress" || node.status === "running") ? "is-pending" : ""}
              />
            </section>
          ))}
        </div>
      ) : (
        <FileTree
          files={tree}
          ariaLabel="Task artifacts"
          emptyText={emptyText}
          renderMeta={(node) => <RunArtifactMeta node={node} />}
          getNodeClass={(node) => node.type === "file" && (node.status === "in_progress" || node.status === "running") ? "is-pending" : ""}
        />
      )}
    </div>
  );
}
