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

// A native subagent's work arrives as flat `subagent_activity` rows keyed by
// the initiating parent tool-use id in `subagent.id`. Older retained logs may
// instead carry that id in `subagent.toolUseId`. Fold each delegation into one
// group so the child's thinking and tool
// calls render nested under that call instead of interleaved with the parent's
// own output — the same shape as the file_edit collapse below, one level down.
function subagentParentToolUseId(event) {
  return event?.subagent?.id || event?.subagent?.toolUseId || null;
}

function collectSubagentGroups(flat) {
  const byId = new Map();
  for (const event of flat) {
    if (event?.type !== "subagent_activity") continue;
    const id = subagentParentToolUseId(event);
    if (!id) continue;
    let group = byId.get(id);
    if (!group) {
      group = {
        _subagentGroup: true,
        _groupId: id,
        subagent: { ...event.subagent },
        parentToolUseIds: new Set(),
        rows: [],
        done: false,
        omittedRows: 0,
      };
      byId.set(id, group);
    }
    // Preserve the root descriptor while filling fields that may only arrive on
    // later events. Codex descendants share this group id but can have distinct
    // nativeId/agentPath metadata on their individual rows.
    for (const [key, value] of Object.entries(event.subagent || {})) {
      if (group.subagent[key] == null && value != null) group.subagent[key] = value;
    }
    group.parentToolUseIds.add(id);
    group.omittedRows = Math.max(
      group.omittedRows,
      Number(event._worklab_subagent_omitted_rows) || 0,
    );
    if (event.phase === "agent_started") group.opened = event;
    else if (event.phase === "agent_completed") {
      group.closed = event;
      group.done = true;
    } else group.rows.push(event);
  }
  return { byId };
}

function isNativeSubagentParentTool(name) {
  const compact = String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return compact === "agent"
    || compact === "task"
    || compact === "spawnagent"
    || compact === "codexspawnagent"
    || compact === "collaborationspawnagent";
}

function groupEvents(events) {
  const flat = flattenEvents(events);
  const subagentGroups = collectSubagentGroups(flat);
  const renderedSubagentIds = new Set();
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
  const subagentGroupsByToolUseId = new Map();
  for (const group of subagentGroups.byId.values()) {
    for (const parentToolUseId of group.parentToolUseIds) {
      const parent = toolUsesByToolUseId.get(parentToolUseId);
      if (parent && isNativeSubagentParentTool(parent.name)) {
        subagentGroupsByToolUseId.set(parentToolUseId, group);
        break;
      }
    }
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
  // Decided up front: `task_started` always follows its Agent tool_use, but a
  // truncated or resumed log can break that, and claiming mid-loop would then
  // render the group twice.
  const claimedSubagentIds = new Set();
  for (const group of subagentGroupsByToolUseId.values()) {
    claimedSubagentIds.add(group._groupId);
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
      const subagentGroup = subagentGroupsByToolUseId.get(event.tool_use_id) || null;
      items.push({ _toolCall: true, toolUse, toolResult: paired, structuredOutput, subagentGroup });
      continue;
    }
    if (event?.type === "subagent_activity") {
      // Render a group standalone only when no Agent tool call will claim it —
      // which happens when the parent's tool_use fell outside a truncated log,
      // or on a run resumed after the delegation started. Emitted once, at its
      // first row, so it keeps its place in the timeline.
      const group = subagentGroups.byId.get(subagentParentToolUseId(event));
      if (!group || claimedSubagentIds.has(group._groupId)) continue;
      if (renderedSubagentIds.has(group._groupId)) continue;
      renderedSubagentIds.add(group._groupId);
      items.push(group);
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

export function acpContextUsageText(event = {}) {
  const used = Number.isFinite(event.used) ? event.used : null;
  const window = Number.isFinite(event.window) ? event.window : null;
  const context = used != null && window != null
    ? `${used.toLocaleString()} / ${window.toLocaleString()} tokens`
    : used != null
      ? `${used.toLocaleString()} tokens used`
      : window != null
        ? `${window.toLocaleString()} token window`
        : "Context usage updated";
  const amount = Number.isFinite(event.cost?.amount) ? event.cost.amount : null;
  const currency = event.cost?.currency || "";
  return amount == null ? context : `${context} · ${amount.toLocaleString()}${currency ? ` ${currency}` : ""}`;
}

function AcpSummaryBlock({ event }) {
  return (
    <div class="agentlog-structured-output">
      <div class="agentlog-event-text">{event.title || "ACP session updated"}</div>
      {event.detail && <div class="agentlog-final-meta">{event.detail}</div>}
      {event.items?.length > 0 && (
        <div class="agentlog-structured-rows">
          {event.items.map((item, index) => (
            <div class="agentlog-structured-row" key={`${item.label}-${index}`}>
              <span>{item.label}</span>
              <strong>{item.detail || "Updated"}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AcpPlanBlock({ event }) {
  return (
    <div class="agentlog-structured-output">
      <div class="agentlog-event-text">{event.title || "ACP plan updated"}</div>
      {event.entries?.length > 0 ? (
        <div class="agentlog-structured-rows">
          {event.entries.map((entry, index) => {
            const state = [entry.status, entry.priority].filter(Boolean).join(" · ") || `Step ${index + 1}`;
            return (
              <div class="agentlog-structured-row" key={`${state}-${index}`}>
                <span>{state}</span>
                <strong>{entry.content || "Plan entry updated"}</strong>
              </div>
            );
          })}
        </div>
      ) : (
        <div class="agentlog-final-meta">No plan contents were included.</div>
      )}
    </div>
  );
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

// Collapse a delegation's rows into one line each: a tool call pairs its
// started/completed rows so the row can show a duration, and the child's
// thinking/text stay in order between them.
function subagentPathLabel(value) {
  if (Array.isArray(value)) return value.map((part) => String(part || "").trim()).filter(Boolean).join(" → ");
  return String(value || "").trim();
}

function subagentRows(group, { limit = null } = {}) {
  const sourceRows = Array.isArray(group.rows) ? group.rows : [];
  const bounded = Number.isFinite(limit) && limit > 0 && sourceRows.length > limit
    ? sourceRows.slice(-limit)
    : sourceRows;
  const omittedRows = (Number(group.omittedRows) || 0) + (sourceRows.length - bounded.length);
  const rows = [];
  const openByRowId = new Map();
  for (const row of bounded) {
    const agentPath = subagentPathLabel(row.subagent?.agentPath);
    if (row.phase === "started") {
      const entry = { kind: "tool", name: row.name, agentPath, durationMs: null, isError: false, content: null };
      openByRowId.set(row.id, entry);
      rows.push(entry);
      continue;
    }
    if (row.phase === "completed") {
      const entry = openByRowId.get(row.id);
      openByRowId.delete(row.id);
      const target = entry || { kind: "tool", name: row.name, agentPath, durationMs: null, isError: false, content: null };
      if (!entry) rows.push(target);
      target.durationMs = row.executionMs ?? null;
      target.isError = Boolean(row.isError);
      target.content = row.content ?? null;
      continue;
    }
    if (row.phase === "message") {
      rows.push({
        kind: row.kind === "thinking" ? "thinking" : "text",
        name: null,
        agentPath,
        content: row.content || "",
      });
    }
  }
  return { rows, omittedRows };
}

function displaySubagentContent(value) {
  return structuredPreview(value) || "";
}

export function subagentGroupFailed(group) {
  return Boolean(group?.closed?.isError);
}

export function toolCallHasError(toolResult, subagentGroup) {
  return Boolean(toolResult?.is_error || toolResult?.error || subagentGroupFailed(subagentGroup));
}

function SubagentGroupBlock({ group, streaming = false }) {
  const [expanded, setExpanded] = useState(false);
  const { rows, omittedRows } = subagentRows(group, { limit: streaming ? 200 : null });
  const closed = group.closed;
  const name = group.subagent?.name || "subagent";
  const label = group.subagent?.label;
  const toolCount = rows.filter((row) => row.kind === "tool").length;
  const totalTokens = closed?.totalTokens ?? group.subagent?.totalTokens;
  const costUsd = closed?.costUsd ?? group.subagent?.costUsd;
  const parts = [
    closed?.executionMs != null ? formatDuration(closed.executionMs) : null,
    `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    totalTokens != null ? `${formatTokens(totalTokens)} tokens` : null,
    costUsd != null ? `$${Number(costUsd).toFixed(5)}` : null,
  ].filter(Boolean);
  const running = !group.done;
  const failed = subagentGroupFailed(group);
  return (
    <div class={`agentlog-phase-cluster agentlog-subagent-group${failed ? " agentlog-subagent-group-error" : ""}`}>
      <button
        type="button"
        class="agentlog-phase-header"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span>
          {`Agent → ${name}`}
          {label ? ` · ${label}` : ""}
          {failed ? " · failed" : running ? " · running" : ""}
          {parts.length ? ` · ${parts.join(" · ")}` : ""}
        </span>
        <Icon name="chevron-down" size={14} class={`agentlog-coll-arrow ${expanded ? "open" : ""}`} />
      </button>
      {expanded && (
        <div class="agentlog-phase-rows">
          {omittedRows > 0 && (
            <div class="agentlog-phase-row agentlog-phase-sub agentlog-subagent-omitted">
              <span>{`${omittedRows.toLocaleString()} earlier activity row${omittedRows === 1 ? "" : "s"} omitted`}</span>
            </div>
          )}
          {rows.length === 0 && (
            <div class="agentlog-phase-row">
              <span class="agentlog-phase-name">
                {running ? "Working…" : "No recorded activity for this delegation."}
              </span>
            </div>
          )}
          {rows.map((row, index) => (
            <div class="agentlog-phase-row agentlog-phase-sub agentlog-subagent-row" key={`${row.kind}-${index}`}>
              <span class="agentlog-subagent-row-content">
                <span class="agentlog-subagent-row-label">
                  {row.agentPath ? `${row.agentPath} · ` : ""}
                  {row.kind === "tool" ? row.name : row.kind === "thinking" ? "Thinking" : "Message"}
                  {row.kind === "tool" && row.isError ? " — failed" : ""}
                </span>
                {row.kind !== "tool" && row.content ? (
                  <span class="agentlog-subagent-output">{displaySubagentContent(row.content)}</span>
                ) : null}
              </span>
              {row.kind === "tool" && row.durationMs != null && (
                <span class="agentlog-phase-duration">{formatDuration(row.durationMs)}</span>
              )}
            </div>
          ))}
          {closed?.content && (
            <div class="agentlog-phase-row agentlog-subagent-row">
              <span class="agentlog-subagent-row-content">
                <span class="agentlog-subagent-row-label">Result</span>
                <span class="agentlog-subagent-output">{displaySubagentContent(closed.content)}</span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentGroupTimelineItem({ group, isLast, streaming }) {
  return (
    <div class="agentlog-tl-item">
      <div class="agentlog-tl-rail">
        <RailIcon name="users" tone={group.closed?.isError ? "error" : group.done ? "ok" : "muted"} />
        {!isLast && <div class="agentlog-tl-line" />}
      </div>
      <div class="agentlog-tl-content">
        <SubagentGroupBlock group={group} streaming={streaming} />
      </div>
    </div>
  );
}

function ToolCallTimelineItem({ toolUse, toolResult, structuredOutput, subagentGroup, messageStatus, isLast, streaming }) {
  const isError = toolCallHasError(toolResult, subagentGroup);
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
        {subagentGroup && <SubagentGroupBlock group={subagentGroup} streaming={streaming} />}
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
  } else if (type === "acp_session_update" || type === "acp_interaction") {
    railIcon = <RailIcon name={type === "acp_interaction" ? "hand" : "refresh-cw"} tone="muted" />;
    content = <AcpSummaryBlock event={event} />;
  } else if (type === "acp_plan") {
    railIcon = <RailIcon name="layout-list" tone="muted" />;
    content = <AcpPlanBlock event={event} />;
  } else if (type === "acp_context_usage") {
    railIcon = <RailIcon name="database" tone="muted" />;
    content = <div class="agentlog-final-meta">ACP context: {acpContextUsageText(event)}</div>;
  } else if (type === "acp_provider_status") {
    railIcon = <RailIcon name="refresh-cw" tone="warn" />;
    const attempt = Number.isFinite(event.retryIndex)
      ? ` · retry ${event.retryIndex + 1}`
      : Number.isFinite(event.attemptIndex)
        ? ` · attempt ${event.attemptIndex + 1}`
        : "";
    content = <div class="agentlog-event-warn">{event.title || "ACP provider updated"}{attempt}</div>;
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
        if (item?._subagentGroup) {
          return <SubagentGroupTimelineItem key={`subagent-${item.subagent?.id || index}`} group={item} isLast={isLast} streaming={streaming} />;
        }
        if (item?._toolCall) {
          return (
            <ToolCallTimelineItem
              key={`tool-${item.toolUse?.tool_use_id || index}`}
              toolUse={item.toolUse}
              toolResult={item.toolResult}
              structuredOutput={item.structuredOutput}
              subagentGroup={item.subagentGroup}
              messageStatus={effectiveStatus}
              isLast={isLast}
              streaming={streaming}
            />
          );
        }
        return <TimelineEvent key={index} event={item} isLast={isLast} streaming={itemStreaming} />;
      })}
    </div>
  );
}
