import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { CodeBlock } from "../../components/CodeBlock.jsx";
import { Drawer } from "../../components/Drawer.jsx";
import { EventTimeline } from "../../components/EventTimeline.jsx";
import { FileTree } from "../../components/FileTree.jsx";
import { Icon } from "../../components/Icon.jsx";
import { MarkdownContent } from "../../components/Markdown.jsx";
import { AgentReferenceText } from "../../components/AgentLink.jsx";
import { Button } from "../../components/primitives/Button.jsx";
import { IconButton } from "../../components/primitives/IconButton.jsx";
import { Textarea } from "../../components/primitives/Textarea.jsx";
import { api } from "../../lib/api.js";
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
  const cacheCreation = Number(run?.log?.cache_creation_tokens) || 0;
  const summary = run?.tool_usage_summary || null;
  const cacheHitRatio = Number.isFinite(Number(summary?.cache?.hitRatio)) ? Number(summary.cache.hitRatio) : null;
  const haveOverhead = Number.isFinite(overheadTokens) && overheadTokens > 0;
  const haveInput = Number.isFinite(inputTokens) && inputTokens > 0;
  if (!haveOverhead && !haveInput && !truncatedCount && !prunedCount && !compactionCount && !cacheCreation && cacheHitRatio == null) return null;
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
        {cacheCreation > 0 && <RunMetric label="Cache write" value={`${cacheCreation.toLocaleString()} tok`} />}
        {cacheHitRatio != null && <RunMetric label="Cache hit rate" value={`${Math.round(cacheHitRatio * 100)}%`} />}
        {truncatedCount > 0 && <RunMetric label="Truncated" value={`${truncatedCount}`} />}
        {prunedCount > 0 && <RunMetric label="Pruned" value={`${prunedCount}`} />}
        {compactionCount > 0 && <RunMetric label="Compactions" value={`${compactionCount}`} />}
      </Toolbar>
    </details>
  );
}

// Renders the per-call capability vector the agent runtime reports
// (capabilitiesUsed). Null fields mean "this provider can't tell" — we
// render those as muted "?" chips so users see what we know vs. don't.
function RunCapabilitiesPanel({ run }) {
  const caps = run?.capabilities_used;
  if (!caps || typeof caps !== "object") return null;
  const chips = [];
  function tristateChip(label, value) {
    if (value === true) chips.push({ label, tone: "on" });
    else if (value === false) chips.push({ label, tone: "off" });
    else chips.push({ label, tone: "unknown" });
  }
  tristateChip("Prompt cache", caps.prompt_cache_active);
  tristateChip("Thinking", caps.thinking_enabled);
  tristateChip("Structured output", caps.structured_output_enforced);
  if (caps.subagent_invoked !== null && caps.subagent_invoked !== undefined) {
    tristateChip("Subagent", caps.subagent_invoked);
  }
  if (caps.tool_compaction_applied) chips.push({ label: "Tool compaction", tone: "on" });
  if (caps.context_compaction_applied === true) chips.push({ label: "Context compaction", tone: "on" });
  const mcp = Array.isArray(caps.mcp_servers_used) ? caps.mcp_servers_used : [];
  const subagents = Array.isArray(caps.native_subagents_used) ? caps.native_subagents_used : [];
  if (chips.length === 0 && mcp.length === 0 && subagents.length === 0) return null;
  return (
    <details class="run-diagnostics run-capabilities">
      <summary>Capabilities used</summary>
      <Toolbar class="run-capabilities-chips" align="start">
        {chips.map((chip) => (
          <span key={chip.label} class={`run-capability-chip run-capability-${chip.tone}`}>{chip.label}</span>
        ))}
        {mcp.length > 0 && (
          <span class="run-capability-chip run-capability-on">MCP: {mcp.join(", ")}</span>
        )}
        {subagents.length > 0 && (
          <span class="run-capability-chip run-capability-on">Subagents: {subagents.join(", ")}</span>
        )}
      </Toolbar>
    </details>
  );
}

// Only renders when the per-agent fallback chain (createRouterRuntime)
// produced one or more attempts before this run succeeded (or before the
// chain was exhausted). Surfaces each failover hop so the user sees the
// route the runtime actually walked.
// HITL approval drawer. Fetches `/api/runs/:id/approvals` on mount and
// whenever the run stream surfaces a fresh `approval_requested` event,
// then offers approve / deny / always actions. Designed to stay close to
// the run card so the user can see what tool is asking and what arguments
// it wants to use without leaving context.
function RunApprovalsPanel({ run, runStreamEvents }) {
  const runId = run?.id;
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(null);
  const [reasonByRequest, setReasonByRequest] = useState({});

  const refresh = async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const data = await api.listRunApprovals(runId);
      if (Array.isArray(data?.approvals)) setApprovals(data.approvals);
    } catch { /* surface via toast elsewhere */ }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [runId]);

  // Re-fetch whenever a new approval_requested event arrives in the stream;
  // a small set of types triggers a refresh rather than a per-event merge so
  // the UI stays close to canonical DB state.
  useEffect(() => {
    if (!Array.isArray(runStreamEvents) || !runStreamEvents.length) return;
    const last = runStreamEvents[runStreamEvents.length - 1];
    if (!last) return;
    if (last.type === "approval_requested" || last.type === "tool_approval_granted" || last.type === "tool_approval_denied") {
      refresh();
    }
  }, [runStreamEvents?.length]);

  const pending = approvals.filter((row) => row.status === "pending");
  const settled = approvals.filter((row) => row.status !== "pending");
  if (!pending.length && !settled.length) return null;

  async function decide(approval, decision) {
    setSubmitting(approval.request_id);
    try {
      await api.decideRunApproval(runId, approval.request_id, {
        decision,
        reason: reasonByRequest[approval.request_id] || null,
      });
      await refresh();
    } catch { /* toast */ }
    finally { setSubmitting(null); }
  }

  return (
    <details class="run-diagnostics run-approvals" open={pending.length > 0}>
      <summary>{pending.length ? `Pending approvals (${pending.length})` : `Approvals (${settled.length})`}</summary>
      {pending.map((row) => (
        <div key={row.request_id} class="run-approval-item run-approval-pending">
          <InlineHead class="run-approval-head">
            <span class="run-approval-tool">{row.tool_name}</span>
            <span class={`run-capability-chip run-capability-${row.risk_tier === "high" ? "off" : "on"}`}>{row.risk_tier}</span>
            {row.model && <span class="run-approval-model">{row.model}</span>}
          </InlineHead>
          {row.arguments_summary && (
            <pre class="run-approval-args">{row.arguments_summary}</pre>
          )}
          <Textarea
            rows={2}
            placeholder="Optional reason for your decision…"
            value={reasonByRequest[row.request_id] || ""}
            onInput={(e) => setReasonByRequest({ ...reasonByRequest, [row.request_id]: e.target.value })}
          />
          <Toolbar class="run-approval-actions" align="start">
            <Button disabled={submitting === row.request_id} onClick={() => decide(row, "approve")}>Approve</Button>
            <Button disabled={submitting === row.request_id} onClick={() => decide(row, "always")}>Always allow</Button>
            <Button disabled={submitting === row.request_id} kind="danger" onClick={() => decide(row, "deny")}>Deny</Button>
          </Toolbar>
        </div>
      ))}
      {settled.length > 0 && (
        <ul class="run-approval-history">
          {settled.map((row) => (
            <li key={row.request_id} class={`run-approval-item run-approval-${row.status}`}>
              <InlineHead class="run-approval-head">
                <span class="run-approval-tool">{row.tool_name}</span>
                <span class="run-approval-status">{row.status}</span>
                {row.decided_by && <span class="run-approval-by">by {row.decided_by}</span>}
                {row.reason && <span class="run-approval-reason">— {row.reason}</span>}
              </InlineHead>
            </li>
          ))}
        </ul>
      )}
      {loading && <div class="agentlog-final-meta">Refreshing approvals…</div>}
    </details>
  );
}

function RunFailoverHistoryPanel({ run }) {
  const history = Array.isArray(run?.failover_history) ? run.failover_history : null;
  if (!history || history.length === 0) return null;
  return (
    <details class="run-diagnostics run-failover">
      <summary>{`Failover history (${history.length})`}</summary>
      <ul class="run-failover-list">
        {history.map((entry, index) => {
          const model = entry?.model?.model || entry?.model?.reference || "(unknown)";
          const reason = entry?.failureKind || entry?.retryableSubkind || "skipped";
          const reqId = entry?.requestId ? ` · req ${entry.requestId}` : "";
          return (
            <li key={index} class="run-failover-item">
              <span class="run-failover-model">{model}</span>
              <span class="run-failover-reason">{reason}{reqId}</span>
            </li>
          );
        })}
      </ul>
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
      <RunCapabilitiesPanel run={run} />
      <RunApprovalsPanel run={run} runStreamEvents={events} />
      <RunFailoverHistoryPanel run={run} />
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
  if (delta && delta !== "0->0" && delta !== "+0 -0") return delta;
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

function languageForPath(path = "") {
  const lower = String(path).toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const map = {
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx",
    json: "json", md: "markdown", yml: "yaml", yaml: "yaml",
    css: "css", scss: "scss", html: "html", xml: "xml",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    sh: "bash", sql: "sql", toml: "toml",
  };
  return map[ext] || "text";
}

const FILE_PREVIEW_DEFAULT_WIDTH = 560;
const FILE_PREVIEW_MIN_WIDTH = 360;
const FILE_PREVIEW_COMPACT_BP = 860;

function useIsCompactViewport(breakpoint = FILE_PREVIEW_COMPACT_BP) {
  const [isCompact, setIsCompact] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(`(max-width: ${breakpoint}px)`).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (event) => setIsCompact(event.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [breakpoint]);
  return isCompact;
}

function FilePreviewDrawer({ file, taskId, onClose }) {
  const [state, setState] = useState({ status: "idle", data: null, error: null });
  const [width, setWidth] = useState(FILE_PREVIEW_DEFAULT_WIDTH);
  const [isFull, setIsFull] = useState(false);
  const [view, setView] = useState("preview");
  const isCompact = useIsCompactViewport();
  const isMarkdown = !!file && /\.(md|markdown)$/i.test(file.path || "");

  useEffect(() => {
    if (!file) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading", data: null, error: null });
    setView(isMarkdown ? "preview" : "source");
    api
      .readFile({ path: file.path, task_id: taskId || "" }, { signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setState({ status: "ready", data, error: null });
      })
      .catch((err) => {
        if (cancelled || err?.name === "AbortError") return;
        setState({ status: "error", data: null, error: err?.message || "Failed to load file" });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file?.path, taskId, isMarkdown]);

  const handleResize = (startEvent) => {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startWidth = isFull ? window.innerWidth : width;
    if (isFull) {
      setWidth(startWidth);
      setIsFull(false);
    }
    const resizeHandle = startEvent.currentTarget;
    resizeHandle?.setPointerCapture?.(startEvent.pointerId);
    const onMove = (event) => {
      const dx = startX - event.clientX;
      const next = Math.max(FILE_PREVIEW_MIN_WIDTH, Math.min(window.innerWidth, startWidth + dx));
      setWidth(next);
    };
    const onUp = () => {
      if (resizeHandle?.hasPointerCapture?.(startEvent.pointerId)) {
        resizeHandle.releasePointerCapture(startEvent.pointerId);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  if (!file) return null;
  const title = file.display_path || file.path || file.name;
  const data = state.data;
  const showMarkdownToggle = isMarkdown && data?.encoding === "utf8";
  const headerActions = (
    <>
      {showMarkdownToggle && (
        <div class="file-preview-view-toggle" role="group" aria-label="View mode">
          <Button
            type="button"
            size="sm"
            variant={view === "preview" ? "secondary" : "ghost"}
            onClick={() => setView("preview")}
            aria-pressed={view === "preview"}
          >Rendered</Button>
          <Button
            type="button"
            size="sm"
            variant={view === "source" ? "secondary" : "ghost"}
            onClick={() => setView("source")}
            aria-pressed={view === "source"}
          >Source</Button>
        </div>
      )}
      {!isCompact && (
        <IconButton
          icon={<Icon name={isFull ? "minimize" : "maximize"} size={14} />}
          aria-label={isFull ? "Restore size" : "Maximize"}
          onClick={() => setIsFull((v) => !v)}
        />
      )}
    </>
  );
  const drawerWidth = isCompact ? undefined : (isFull ? "100vw" : `${width}px`);
  return (
    <Drawer
      open
      onClose={onClose}
      title={title}
      class="file-preview-drawer"
      width={drawerWidth}
      headerActions={headerActions}
      onResizeStart={isCompact ? undefined : handleResize}
    >
      {state.status === "loading" && <div class="field-hint">Loading…</div>}
      {state.status === "error" && (
        <div class="field-hint" role="alert">Failed to load: {state.error}</div>
      )}
      {state.status === "ready" && data && (
        <>
          <div class="file-preview-meta">
            <span class="file-preview-path" title={data.abs_path}>{data.abs_path}</span>
            <span class="file-preview-size">{data.size} bytes{data.truncated ? " · truncated" : ""}</span>
          </div>
          {data.encoding === "binary" && <div class="field-hint">Binary file — preview not available.</div>}
          {data.encoding === "too_large" && <div class="field-hint">File exceeds preview limit ({data.max_bytes} bytes).</div>}
          {data.encoding === "utf8" && (
            isMarkdown && view === "preview" ? (
              <MarkdownContent content={data.content} className="markdown doc-content file-preview-markdown" expandable={false} />
            ) : (
              <CodeBlock code={data.content} language={languageForPath(file.path)} class="file-preview-code" />
            )
          )}
        </>
      )}
    </Drawer>
  );
}

export function RunArtifactsSection({ task, runningRun, streamState = null }) {
  const isStreaming = Boolean(runningRun);
  const fallbackStream = useRunStream(streamState ? null : runningRun?.id, { subscribe: isStreaming });
  const effectiveStream = streamState || fallbackStream;
  const events = effectiveStream.events || [];
  const loading = effectiveStream.loading;
  const [previewFile, setPreviewFile] = useState(null);
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
  const canPreviewArtifact = (node) => {
    if (!node || node.type !== "file" || !node.path) return false;
    if (node.artifact_type === "git_commit") return false;
    if (node.kind === "delete" || node.status === "deleted") return false;
    return true;
  };
  const handleFileClick = (node) => {
    if (!canPreviewArtifact(node)) return;
    setPreviewFile(node);
  };

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
        onFileClick={handleFileClick}
        canFileClick={canPreviewArtifact}
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
                  onFileClick={handleFileClick}
                  canFileClick={canPreviewArtifact}
                />
              </SectionGroup>
            ))}
          </SectionStack>
        </details>
      )}
      <FilePreviewDrawer file={previewFile} taskId={task.id} onClose={() => setPreviewFile(null)} />
    </SectionGroup>
  );
}
