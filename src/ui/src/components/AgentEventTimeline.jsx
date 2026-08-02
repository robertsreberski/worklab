import { useEffect, useMemo, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { ToolCallBlock } from "./ToolCallBlock.jsx";
import { StructuredContent } from "./StructuredContent.jsx";
import { StructuredValue } from "./StructuredValue.jsx";
import { structuredPreview } from "../lib/structuredValue.js";
import { hasFileEditChangeDetails, isMutationToolName, sourceToolIdForFileEditId } from "../lib/toolEventLinking.js";
import { REDACTED_THINKING_HINT, redactedThinkingLabel, thinkingProgressLabel } from "../lib/thinkingEvents.js";

const PHASE_NAMES = Object.freeze({
  triage: "Triage",
  semantic_search: "Semantic search",
  build_context: "Build context",
  "build_context.files": "Context files",
  "build_context.history": "Context history",
  "build_context.skills": "Context skills",
  resolve_model: "Resolve model",
  mcp_config: "MCP config",
  session_create: "SDK cold spawn",
  session_reuse: "SDK warm reuse",
  sdk_open: "SDK warmup",
  sdk_api: "API call",
  post_query: "Post-query",
});

function formatDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n) {
  if (n == null) return null;
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatFinalMeta(event) {
  const usage = event.usage || {};
  return [
    event.model,
    usage.input_tokens != null ? `in ${formatTokens(usage.input_tokens)}` : null,
    usage.output_tokens != null ? `out ${formatTokens(usage.output_tokens)}` : null,
    usage.cache_read_tokens != null ? `cache ${formatTokens(usage.cache_read_tokens)}` : null,
    event.durationMs != null ? formatDuration(event.durationMs) : null,
    event.numTurns != null ? `${event.numTurns} turns` : null,
    usage.cost_usd != null ? `$${Number(usage.cost_usd).toFixed(5)}` : null,
  ].filter(Boolean).join(" / ");
}

function RailIcon({ name, tone }) {
  const toneClass = tone && tone !== "muted" ? ` agentlog-tl-icon-${tone}` : "";
  return (
    <span class={`agentlog-tl-icon${toneClass}`}>
      <Icon name={name} size={12} strokeWidth={2} />
    </span>
  );
}

function normaliseBlock(block) {
  if (!block) return null;
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      tool_use_id: block.tool_use_id || block.id,
      name: block.name,
      input: block.input,
      display_name: block.display_name || block.displayName,
      source_tool_use_id: block.source_tool_use_id || block.sourceToolUseId,
    };
  }
  if (block.type === "thinking") {
    const text = block.text || block.thinking || "";
    if (block.redacted) {
      return { type: "thinking", text, redacted: true, estimated_tokens: block.estimated_tokens ?? null };
    }
    return { type: "thinking", text };
  }
  if (block.type === "text") return { type: "text", text: block.text || "" };
  if (block.type === "tool_result") {
    const output = toolResultDisplayValue(block);
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      output,
      content: block.content,
      result: block.result,
      error: block.error,
      message: block.message,
      is_error: Boolean(block.is_error || block.error),
      raw_result: block.raw_result,
    };
  }
  if (block.type === "structured_output") {
    return {
      type: "structured_output",
      tool_use_id: block.tool_use_id || null,
      value: block.value ?? block.structured_output ?? block.result,
      worklab_result: block.worklab_result,
      source: block.source || null,
    };
  }
  return block;
}

function hasDisplayValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function toolResultDisplayValue(toolResult) {
  const explicit = toolResult?.output ?? toolResult?.content ?? toolResult?.result;
  if (hasDisplayValue(explicit)) return explicit;
  if (hasDisplayValue(toolResult?.error)) return toolResult.error;
  if (hasDisplayValue(toolResult?.message)) return toolResult.message;
  return explicit ?? "";
}

function mergeStreamingText(current, next) {
  const left = current || "";
  const right = next || "";
  if (!right) return left;
  if (!left) return right;
  if (left === right) return left;

  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed && rightTrimmed) {
    if (leftTrimmed === rightTrimmed) return left;
    if (rightTrimmed.length >= leftTrimmed.length && rightTrimmed.startsWith(leftTrimmed)) return right;
  }

  return `${left}${right}`;
}

// Only streamed fragments merge. A redacted thinking marker carries no text, so
// merging would silently swallow it into the neighbouring row.
function canMergeStreamingBlocks(last, next) {
  if (next?.type !== "thinking" && next?.type !== "text") return false;
  if (last?.type !== next.type) return false;
  if (last.redacted || next.redacted) return false;
  return Boolean(String(last.text || "").trim()) && Boolean(String(next.text || "").trim());
}

function flattenEvents(events) {
  const flat = [];
  for (const event of events || []) {
    if (!event) continue;
    const content = event.message?.content || event.content;
    if ((event.type === "assistant" || event.type === "message" || event.type === "user") && Array.isArray(content)) {
      for (const block of content) {
        const next = normaliseBlock(block);
        if (next) flat.push(next);
      }
      continue;
    }
    flat.push(normaliseBlock(event));
  }

  const coalesced = [];
  for (const event of flat) {
    const last = coalesced[coalesced.length - 1];
    if (canMergeStreamingBlocks(last, event)) {
      last.text = mergeStreamingText(last.text, event.text);
    } else {
      coalesced.push(event);
    }
  }
  return coalesced;
}

function groupEvents(events) {
  const flat = flattenEvents(events);
  const toolUsesByToolUseId = new Map();
  const resultsByToolUseId = new Map();
  const structuredByToolUseId = new Map();
  for (const event of flat) {
    if (event?.type === "tool_use" && event.tool_use_id) {
      toolUsesByToolUseId.set(event.tool_use_id, event);
    }
    if (event?.type === "tool_result" && event.tool_use_id) resultsByToolUseId.set(event.tool_use_id, event);
    if (event?.type === "structured_output" && event.tool_use_id) structuredByToolUseId.set(event.tool_use_id, event);
  }
  const collapsedSourceToolUseIds = new Set();
  const fileEditMetadataByToolUseId = new Map();
  for (const event of flat) {
    if (event?.type !== "tool_use" || event.name !== "file_edit" || !event.tool_use_id) continue;
    const sourceToolUseId = sourceToolIdForFileEditId(event.tool_use_id);
    if (!sourceToolUseId) continue;
    const sourceToolUse = toolUsesByToolUseId.get(sourceToolUseId);
    if (!isMutationToolName(sourceToolUse?.name)) continue;
    const paired = resultsByToolUseId.get(event.tool_use_id) || null;
    if (!hasFileEditChangeDetails(event, paired)) continue;
    collapsedSourceToolUseIds.add(sourceToolUseId);
    fileEditMetadataByToolUseId.set(event.tool_use_id, {
      display_name: sourceToolUse.name,
      source_tool_use_id: sourceToolUseId,
      source_tool_input: sourceToolUse.input,
    });
  }
  const consumedResultIds = new Set();
  const consumedStructuredIds = new Set();
  const items = [];
  let cluster = null;
  const flush = () => {
    if (cluster) {
      items.push(cluster);
      cluster = null;
    }
  };

  for (const event of flat) {
    if (event?.type === "phase") {
      if (!cluster) cluster = { _cluster: true, events: [] };
      cluster.events.push(event);
      continue;
    }
    flush();

    if (event?.type === "tool_use" && event.tool_use_id) {
      if (collapsedSourceToolUseIds.has(event.tool_use_id)) continue;
      const paired = resultsByToolUseId.get(event.tool_use_id) || null;
      const structuredOutput = structuredByToolUseId.get(event.tool_use_id) || null;
      if (paired) consumedResultIds.add(event.tool_use_id);
      if (structuredOutput) consumedStructuredIds.add(event.tool_use_id);
      const fileEditMetadata = fileEditMetadataByToolUseId.get(event.tool_use_id);
      const toolUse = fileEditMetadata ? { ...event, ...fileEditMetadata } : event;
      items.push({ _toolCall: true, toolUse, toolResult: paired, structuredOutput });
      continue;
    }
    if (event?.type === "tool_result" && collapsedSourceToolUseIds.has(event.tool_use_id)) continue;
    if (event?.type === "tool_result" && consumedResultIds.has(event.tool_use_id)) continue;
    if (event?.type === "structured_output" && consumedStructuredIds.has(event.tool_use_id)) continue;
    items.push(event);
  }
  flush();
  return items;
}

export function normaliseAgentTimelineEvents(events) {
  return flattenEvents(events);
}

export function groupAgentTimelineEvents(events) {
  return groupEvents(events);
}

export function isActiveStreamingTimelineItem({ streaming, index, length }) {
  return Boolean(streaming && length > 0 && index === length - 1);
}

export function providerRequestTargetLabel(event = {}) {
  const model = String(event.model || "").trim();
  const sdk = String(event.sdk || "").trim();
  if (model && sdk && model.startsWith(`${sdk}:`)) return model;
  if (sdk && model) return `${sdk}/${model}`;
  return model || sdk || "?";
}

export function runtimeWarningText(event = {}) {
  if (event.warning_kind === "mcp_init_failed") {
    const server = event.server || event.name || "server";
    const message = event.message || "unavailable";
    return `MCP ${server} unavailable: ${message}`;
  }
  return event.message || event.warning_kind || "Runtime warning";
}

function CollapsibleBlock({ title, text, value, expanded, onToggle, borderColor, muted }) {
  const payload = value !== undefined ? value : (text || "");
  const previewText = structuredPreview(payload) || "";
  const preview = previewText.slice(0, 140);
  const isLong = previewText.length > 140;
  return (
    <div class="agentlog-collapsible" style={borderColor ? { borderLeftColor: borderColor } : undefined}>
      <button type="button" class="agentlog-coll-header" onClick={onToggle}>
        <span>{title}</span>
        <Icon name="chevron-down" size={14} class={`agentlog-coll-arrow ${expanded ? "open" : ""}`} />
      </button>
      {expanded ? (
        <StructuredValue value={payload} class={muted ? "agentlog-muted" : ""} />
      ) : (
        <pre class={`agentlog-coll-body ${muted ? "agentlog-muted" : ""}`}>
          {`${preview}${isLong ? "..." : ""}`}
        </pre>
      )}
    </div>
  );
}

function structuredOutputValue(event) {
  return event?.worklab_result || event?.value || event?.structured_output || event?.result || {};
}

function StructuredOutputBlock({ event }) {
  const [expanded, setExpanded] = useState(false);
  const value = structuredOutputValue(event);
  const rows = [
    ["Stage", value?.stage],
    ["Decision", value?.decision],
    ["Summary", value?.summary],
    ["Final", value?.final_text],
  ].filter(([, next]) => next !== undefined && next !== null && String(next).trim());

  return (
    <div class="agentlog-structured-output">
      {rows.length ? (
        <div class="agentlog-structured-rows">
          {rows.map(([label, next]) => (
            <div class="agentlog-structured-row" key={label}>
              <span>{label}</span>
              <strong>{String(next)}</strong>
            </div>
          ))}
        </div>
      ) : (
        <StructuredValue value={value} />
      )}
      <CollapsibleBlock
        title="Full JSON"
        value={value}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
      />
    </div>
  );
}

function ThinkingBlock({ text, streaming }) {
  const [expanded, setExpanded] = useState(Boolean(streaming));
  useEffect(() => {
    if (!streaming) setExpanded(false);
  }, [streaming]);
  return (
    <button
      type="button"
      class={`agentlog-thinking ${expanded ? "expanded" : ""}`}
      onClick={() => setExpanded((current) => !current)}
      aria-expanded={expanded}
    >
      <span class="agentlog-thinking-glyph" aria-hidden="true">✦</span>
      <span class="agentlog-thinking-text">{text || ""}</span>
      {streaming && <span class="agentlog-thinking-cursor" aria-hidden="true" />}
    </button>
  );
}

function PhaseClusterBlock({ cluster, isLast }) {
  const [expanded, setExpanded] = useState(false);
  const rows = [];
  const pending = new Map();
  let total = 0;
  for (const event of cluster.events) {
    if (event.status === "start") pending.set(event.phase, event);
    if (event.status === "end") {
      pending.delete(event.phase);
      rows.push({ phase: event.phase, durationMs: event.duration_ms || 0 });
      if (!String(event.phase).includes(".")) total += event.duration_ms || 0;
    }
  }
  const inflight = [...pending.values()];
  const label = inflight.length
    ? `Pipeline running (${rows.length} done)`
    : `Pipeline ${formatDuration(total)} (${rows.length} phase${rows.length === 1 ? "" : "s"})`;
  return (
    <div class="agentlog-tl-item">
      <div class="agentlog-tl-rail">
        {inflight.length ? <span class="agentlog-tl-icon"><span class="agentlog-phase-spinner" /></span> : <RailIcon name="clock" />}
        {!isLast && <div class="agentlog-tl-line" />}
      </div>
      <div class="agentlog-tl-content">
        <div class="agentlog-phase-cluster">
          <button type="button" class="agentlog-phase-header" onClick={() => setExpanded((current) => !current)}>
            <span>{label}</span>
            <Icon name="chevron-down" size={14} class={`agentlog-coll-arrow ${expanded ? "open" : ""}`} />
          </button>
          {expanded && (
            <div class="agentlog-phase-rows">
              {rows.map((row, index) => (
                <div class={String(row.phase).includes(".") ? "agentlog-phase-row agentlog-phase-sub" : "agentlog-phase-row"} key={`${row.phase}-${index}`}>
                  <span class="agentlog-phase-name">{PHASE_NAMES[row.phase] || row.phase}</span>
                  <span class="agentlog-phase-duration">{formatDuration(row.durationMs)}</span>
                </div>
              ))}
              {inflight.map((row, index) => (
                <div class="agentlog-phase-row agentlog-phase-inflight" key={`inflight-${index}`}>
                  <span class="agentlog-phase-name">{PHASE_NAMES[row.phase] || row.phase}</span>
                  <span class="agentlog-phase-duration"><span class="agentlog-phase-spinner" /> running</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolCallTimelineItem({ toolUse, toolResult, structuredOutput, messageStatus, isLast }) {
  const isError = Boolean(toolResult?.is_error || toolResult?.error);
  const isFileEdit = toolUse?.name === "file_edit";
  const isStructuredOutput = toolUse?.name === "StructuredOutput";
  const railName = isError ? "alert-triangle" : isStructuredOutput ? "check-circle" : isFileEdit ? "file-text" : toolResult ? "check" : "terminal";
  const railTone = isError ? "error" : (toolResult || structuredOutput) ? "ok" : "muted";
  return (
    <div class="agentlog-tl-item">
      <div class="agentlog-tl-rail">
        <RailIcon name={railName} tone={railTone} />
        {!isLast && <div class="agentlog-tl-line" />}
      </div>
      <div class="agentlog-tl-content agentlog-tl-content-toolcall">
        <ToolCallBlock
          toolUse={toolUse}
          toolResult={toolResult}
          structuredOutput={structuredOutput}
          messageStatus={messageStatus}
        />
      </div>
    </div>
  );
}

function TimelineEvent({ event, isLast, streaming }) {
  const [expanded, setExpanded] = useState(false);
  if (!event) return null;
  const type = event.type || "unknown";
  let railIcon = <RailIcon name="circle" />;
  let content = null;

  if (type === "text") {
    railIcon = <RailIcon name="message-circle" />;
    const text = event.text || "";
    content = (
      <StructuredContent
        content={text}
        className="agentlog-event-text doc-content"
        maxHeight={5000}
      />
    );
  } else if (type === "live_user_message") {
    railIcon = <RailIcon name="user" tone="accent" />;
    content = (
      <StructuredContent
        content={event.text || ""}
        className="agentlog-event-live-input doc-content"
        maxHeight={2000}
      />
    );
  } else if (type === "thinking" && event.redacted) {
    railIcon = <RailIcon name="sparkles" />;
    content = (
      <div class="agentlog-thinking agentlog-thinking-static" title={REDACTED_THINKING_HINT}>
        <span class="agentlog-thinking-glyph" aria-hidden="true">✦</span>
        <span class="agentlog-final-meta">{redactedThinkingLabel(event)}</span>
      </div>
    );
  } else if (type === "thinking_progress") {
    railIcon = <RailIcon name="sparkles" />;
    content = (
      <div class="agentlog-thinking agentlog-thinking-static" title={REDACTED_THINKING_HINT}>
        <span class="agentlog-thinking-glyph" aria-hidden="true">✦</span>
        <span class="agentlog-final-meta">{thinkingProgressLabel(event)}</span>
        {streaming && <span class="agentlog-thinking-cursor" aria-hidden="true" />}
      </div>
    );
  } else if (type === "thinking") {
    railIcon = <RailIcon name="sparkles" />;
    content = <ThinkingBlock text={event.text || ""} streaming={event.streaming || streaming} />;
  } else if (type === "structured_output") {
    railIcon = <RailIcon name="check-circle" tone="ok" />;
    content = <StructuredOutputBlock event={event} />;
  } else if (type === "tool_result" || type === "tool_output") {
    const isError = event.is_error || event.error;
    railIcon = <RailIcon name={isError ? "alert-triangle" : "check"} tone={isError ? "error" : "ok"} />;
    const resultText = toolResultDisplayValue(event);
    content = (
      <CollapsibleBlock
        title={isError ? "Error" : "Result"}
        value={resultText}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        borderColor={isError ? "var(--accent-alert-border)" : "var(--accent-positive-border)"}
      />
    );
  } else if (type === "result" || type === "final") {
    railIcon = <RailIcon name="check-circle" tone="ok" />;
    if (type === "final" && event.compact) {
      const meta = event.summary || formatFinalMeta(event);
      content = (
        <div
          class="agentlog-final-note"
          title="Persisted final result and usage metadata. The readable answer is shown above and is also posted to Comments."
        >
          <span>Final result recorded</span>
          {meta && <span class="agentlog-final-meta">{meta}</span>}
        </div>
      );
    } else {
      content = event.structured
        ? <StructuredValue value={event.structured} />
        : (
          <StructuredContent
            content={event.text || event.summary || event.output || "Completed"}
            className="agentlog-event-text doc-content"
            maxHeight={5000}
          />
        );
    }
  } else if (type === "error") {
    railIcon = <RailIcon name="alert-triangle" tone="error" />;
    content = (
      <StructuredContent
        content={event.message || event.text || "Error occurred"}
        className="agentlog-event-error doc-content"
        maxHeight={5000}
      />
    );
  } else if (type === "runtime_warning") {
    railIcon = <RailIcon name="alert-triangle" tone="error" />;
    content = (
      <StructuredContent
        content={runtimeWarningText(event)}
        className="agentlog-event-warn doc-content"
        maxHeight={5000}
      />
    );
  } else if (type === "worktree_reconcile") {
    railIcon = <RailIcon name="git-branch" tone={event.tone === "success" ? "success" : "warn"} />;
    const meta = [
      event.status ? event.status.replaceAll("_", " ") : null,
      event.branch,
      event.branchHead,
    ].filter(Boolean).join(" / ");
    content = (
      <div>
        <StructuredContent
          content={event.text || "Worktree reconciliation recorded."}
          className={event.tone === "success" ? "agentlog-event-text doc-content" : "agentlog-event-warn doc-content"}
          maxHeight={5000}
        />
        {meta && <div class="agentlog-final-meta">{meta}</div>}
      </div>
    );
  } else if (type === "retry") {
    railIcon = <RailIcon name="refresh-cw" />;
    content = (
      <StructuredContent
        content={event.message || event.text || "Retrying..."}
        className="agentlog-event-warn doc-content"
        maxHeight={5000}
      />
    );
  } else if (type === "phase") {
    railIcon = <RailIcon name="clock" />;
    content = (
      <div class="agentlog-phase-row">
        <span class="agentlog-phase-name">{PHASE_NAMES[event.phase] || event.phase}</span>
        <span class="agentlog-phase-duration">{event.duration_ms != null ? formatDuration(event.duration_ms) : event.status}</span>
      </div>
    );
  } else if (type === "started") {
    railIcon = <RailIcon name="play" tone="accent" />;
    content = <div class="agentlog-event-text">Run started</div>;
  } else if (type === "cancelled") {
    railIcon = <RailIcon name="circle" tone="error" />;
    content = <div class="agentlog-event-warn">Cancelled</div>;
  } else if (type === "cache_hit" || type === "cache_miss") {
    const tokens = Number(event.tokens) || 0;
    const source = event.source ? ` (${event.source})` : "";
    railIcon = <RailIcon name={type === "cache_hit" ? "check" : "circle"} tone="muted" />;
    content = (
      <div class="agentlog-final-meta">
        {type === "cache_hit" ? "Cache hit" : "Cache miss"}
        {tokens > 0 ? `: ${tokens.toLocaleString()} tok` : ""}
        {source}
      </div>
    );
  } else if (type === "cost_accumulated") {
    const usd = Number(event.cumulativeUsd) || 0;
    railIcon = <RailIcon name="zap" tone="muted" />;
    content = (
      <div class="agentlog-final-meta">
        Running cost: ${usd.toFixed(4)}
        {event.tokens?.input ? ` · in ${Number(event.tokens.input).toLocaleString()}` : ""}
        {event.tokens?.output ? ` · out ${Number(event.tokens.output).toLocaleString()}` : ""}
      </div>
    );
  } else if (type === "capabilities_resolved") {
    railIcon = <RailIcon name="settings" tone="muted" />;
    content = (
      <CollapsibleBlock
        title="Capabilities used"
        value={event.capabilitiesUsed || event.capabilities_used || event}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        muted
      />
    );
  } else if (type === "provider_request_started" || type === "provider_request_completed") {
    railIcon = <RailIcon name="database" tone="muted" />;
    const verb = type === "provider_request_started" ? "Started" : "Completed";
    const latency = type === "provider_request_completed" && Number.isFinite(event.durationMs)
      ? ` · ${Math.round(event.durationMs)} ms`
      : "";
    content = (
      <div class="agentlog-final-meta">
        {verb} provider request: {providerRequestTargetLabel(event)}{latency}
      </div>
    );
  } else if (type === "provider_failover_started" || type === "provider_failover_completed") {
    railIcon = <RailIcon name="refresh-cw" tone="warn" />;
    const verb = type === "provider_failover_started" ? "Failing over" : "Failover completed";
    const target = event.to?.model || event.model?.model || event.model || "?";
    const from = event.from?.model || "?";
    content = (
      <div class="agentlog-event-warn">
        {verb}: {from} → {target}
      </div>
    );
  } else if (type === "tool_approval_pending" || type === "tool_approval_granted" || type === "tool_approval_denied") {
    const isDenied = type === "tool_approval_denied";
    const isPending = type === "tool_approval_pending";
    railIcon = <RailIcon name={isDenied ? "x-circle" : isPending ? "clock" : "check-circle"} tone={isDenied ? "error" : isPending ? "warn" : "ok"} />;
    const label = isPending ? "Awaiting approval" : isDenied ? "Tool denied" : "Tool approved";
    const reason = event.reason ? ` — ${event.reason}` : "";
    content = (
      <div class={isDenied ? "agentlog-event-warn" : "agentlog-final-meta"}>
        {label}: {event.toolName || event.tool_name || "?"}{event.riskTier ? ` (${event.riskTier})` : ""}{reason}
      </div>
    );
  } else if (type === "cli_event" && event.raw) {
    const title = event.raw.type ? `CLI: ${event.raw.type}` : "CLI event";
    content = (
      <CollapsibleBlock
        title={title}
        value={event.raw}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        muted
      />
    );
  } else {
    content = (
      <CollapsibleBlock
        title={type}
        value={event}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
      />
    );
  }

  return (
    <div class="agentlog-tl-item">
      <div class="agentlog-tl-rail">
        {railIcon}
        {!isLast && <div class="agentlog-tl-line" />}
      </div>
      <div class="agentlog-tl-content">{content}</div>
    </div>
  );
}

export function AgentEventTimeline({ events = [], streaming = false, messageStatus }) {
  const items = useMemo(() => groupEvents(events), [events]);
  if (!events.length && !streaming) return null;
  const effectiveStatus = messageStatus || (streaming ? "streaming" : "done");
  return (
    <div class="agentlog-timeline">
      {items.map((item, index) => {
        const isTail = index === items.length - 1;
        const isLast = !streaming && isTail;
        const itemStreaming = isActiveStreamingTimelineItem({ streaming, index, length: items.length });
        if (item?._cluster) return <PhaseClusterBlock key={`cluster-${index}`} cluster={item} isLast={isLast} />;
        if (item?._toolCall) {
          return (
            <ToolCallTimelineItem
              key={`tool-${item.toolUse?.tool_use_id || index}`}
              toolUse={item.toolUse}
              toolResult={item.toolResult}
              structuredOutput={item.structuredOutput}
              messageStatus={effectiveStatus}
              isLast={isLast}
            />
          );
        }
        return <TimelineEvent key={index} event={item} isLast={isLast} streaming={itemStreaming} />;
      })}
    </div>
  );
}
