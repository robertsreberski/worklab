import { useMemo } from "preact/hooks";

import { EventTimeline } from "../../components/EventTimeline.jsx";
import { FileTree } from "../../components/FileTree.jsx";
import { Icon } from "../../components/Icon.jsx";
import { StatusPill } from "../../components/primitives/StatusPill.jsx";
import { useRunStream } from "../../lib/useRunStream.js";
import { formatRunSummaryTitle, runMetricItems, runResultPreview } from "../../lib/runFormatting.js";
import {
  aggregateRunArtifacts,
  artifactDeltaLabel,
  buildRunArtifactTree,
  extractRunArtifacts,
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

function RunWarningsList({ warnings }) {
  if (!Array.isArray(warnings) || !warnings.length) return null;
  return (
    <ul class="run-warnings-list">
      {warnings.map((w, idx) => (
        <li key={idx} class={`run-warning-item run-warning-${(w.kind || "runtime").replace(/[^a-z0-9_-]/gi, "_")}`}>
          <span class="run-warning-kind">{w.kind || "runtime"}</span>
          {w.source && <span class="run-warning-source">{w.source}</span>}
          <span class="run-warning-message">{w.message || ""}</span>
        </li>
      ))}
    </ul>
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

export function RunCard({ run, expanded, highlighted, onToggle, subscribe }) {
  const { events, loading } = useRunStream(expanded || subscribe ? run?.id : null, { subscribe });
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
                  {resultPreview.summary && <span class="run-result-summary">{resultPreview.summary}</span>}
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
                  {run.cancel_initiator && (
                    <span class="run-warning-badge run-cancel-chip" title={run.cancel_reason || run.cancel_initiator}>
                      {run.cancel_initiator}
                    </span>
                  )}
                </div>
                {resultPreview.details && <div class="run-result-details">{resultPreview.details}</div>}
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
      <RunWarningsList warnings={warnings} />
      <RunDiagnosticsDisclosure run={run} />
      <div class="run-card-events">
        {loading ? (
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
    return <span class="run-artifact-meta muted">{node.unavailable_reason}</span>;
  }
  const delta = artifactDeltaLabel(node);
  if (delta) return <span class="run-artifact-meta delta">{delta}</span>;
  if (node.status === "in_progress" || node.status === "running") {
    return <span class="run-artifact-meta pending">pending</span>;
  }
  return null;
}

export function RunArtifactsSection({ task, runningRun }) {
  const isStreaming = Boolean(runningRun);
  const { events, loading } = useRunStream(runningRun?.id, { subscribe: isStreaming });
  const liveArtifacts = useMemo(() => extractRunArtifacts(events), [events]);
  const artifacts = useMemo(() => {
    const taskArtifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
    if (!liveArtifacts.length) return taskArtifacts;
    return aggregateRunArtifacts([
      { artifacts: taskArtifacts },
      { id: runningRun?.id || "running", started_at: runningRun?.started_at, artifacts: liveArtifacts },
    ]);
  }, [task?.artifacts, liveArtifacts, runningRun?.id, runningRun?.started_at]);
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
      ? "No file edits recorded yet."
      : "No file edits recorded.";

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
      <FileTree
        files={tree}
        ariaLabel="Task artifacts"
        emptyText={emptyText}
        renderMeta={(node) => <RunArtifactMeta node={node} />}
        getNodeClass={(node) => node.type === "file" && (node.status === "in_progress" || node.status === "running") ? "is-pending" : ""}
      />
    </div>
  );
}
