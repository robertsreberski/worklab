import { useMemo } from "preact/hooks";
import { AgentEventTimeline } from "./AgentEventTimeline.jsx";
import { normalizeCommentText } from "../lib/commentFormatting.js";
import { hasRedactedThinkingBlock, isRedactedThinkingBlock } from "../lib/thinkingEvents.js";
import { normalizeCodexItemEvent } from "@mono-agent/agent-runtime/ai/streaming/codex-events.js";

function visibleTextFromEvent(ev) {
  if (ev?.type === "sdk_event") return visibleTextFromEvent(ev.event);
  if (ev?.type !== "assistant" && ev?.type !== "message") return "";
  const content = ev?.message?.content || ev?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && String(block.text || "").trim())
    .map((block) => block.text)
    .join("");
}

function isVisibleTextEvent(ev) {
  if (ev?.type === "sdk_event") return isVisibleTextEvent(ev.event);
  if (ev?.type !== "assistant" && ev?.type !== "message") return false;
  const content = ev?.message?.content || ev?.content;
  return Array.isArray(content)
    && content.length > 0
    && content.every((block) => block?.type === "text" && String(block.text || "").trim());
}

function mergeVisibleText(current, next) {
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

function formatFinalUsage(ev) {
  const usage = ev.usage || {};
  return [
    ev.model,
    usage.input_tokens != null ? `in ${usage.input_tokens}` : null,
    usage.output_tokens != null ? `out ${usage.output_tokens}` : null,
    usage.cache_read_tokens != null ? `cache ${usage.cache_read_tokens}` : null,
    ev.durationMs != null ? `${ev.durationMs}ms` : null,
    ev.numTurns != null ? `${ev.numTurns} turns` : null,
    usage.cost_usd != null ? `$${Number(usage.cost_usd).toFixed(5)}` : null,
  ].filter(Boolean).join(" / ");
}

function formatFinalText(ev) {
  const rawText = String(ev.text || "").trim();
  const delivered = normalizeCommentText(rawText);
  if (delivered && (delivered !== rawText || !/^[{[]/.test(rawText))) return delivered;
  const result = ev.worklab_result;
  if (result?.final_text || result?.summary || result?.details) {
    const finalText = String(result.final_text || "").trim();
    if (finalText) return finalText;
    const summary = String(result.summary || "").trim();
    const details = String(result.details || "").trim();
    if (summary && details && summary !== details) return `${summary}\n\n${details}`;
    return details || summary;
  }
  return ev.text || "Completed";
}

function providerResultErrorMessage(ev) {
  const subtype = typeof ev?.subtype === "string" ? ev.subtype : "";
  const hasErrors = Array.isArray(ev?.errors) && ev.errors.length > 0;
  if (!ev?.is_error && !subtype.startsWith("error_") && !hasErrors && !ev?.error) return "";
  if (subtype === "error_max_turns") return "Stopped before final output: max turns reached";
  const label = subtype ? subtype.replace(/^error_/, "").replace(/_/g, " ") : "provider error";
  const detail = typeof ev?.error === "string" ? ev.error : ev?.error?.message;
  return detail ? `${label}: ${detail}` : label;
}

function hasOwn(value, key) {
  return value && Object.prototype.hasOwnProperty.call(value, key);
}

function structuredOutputValue(ev) {
  if (!hasOwn(ev, "structured_output")) return undefined;
  return ev.structured_output;
}

function structuredWorklabResult(value) {
  const candidate = value?.worklab_result || value;
  return candidate?.schema === "worklab.v2" ? candidate : null;
}

function standaloneWorklabResultText(text) {
  const raw = String(text || "").trim();
  if (!raw || raw[0] !== "{") return null;
  try {
    return structuredWorklabResult(JSON.parse(raw));
  } catch {
    return null;
  }
}

function looksLikeCompactedWorklabResultText(text) {
  const raw = String(text || "").trim();
  return raw.startsWith("{")
    && raw.includes("\"schema\":\"worklab.v2\"")
    && /\[truncated \d+ chars; full raw log available\]\s*$/.test(raw);
}

function isStandaloneWorklabResultTextEvent(ev) {
  if (ev?.type !== "assistant" && ev?.type !== "message") return false;
  const content = ev?.message?.content || ev?.content;
  return Array.isArray(content)
    && content.length > 0
    && content.every((block) => block?.type === "text" && (
      standaloneWorklabResultText(block.text) || looksLikeCompactedWorklabResultText(block.text)
    ));
}

function normalizeStructuredOutputEvent(ev, source = "StructuredOutput") {
  const value = ev.value ?? ev.structured_output ?? ev.result;
  const worklabResult = ev.worklab_result || structuredWorklabResult(value);
  return {
    type: "structured_output",
    ...(ev.tool_use_id ? { tool_use_id: ev.tool_use_id } : {}),
    source: ev.source || source,
    value,
    ...(worklabResult ? { worklab_result: worklabResult } : {}),
  };
}

function structuredOutputKey(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function shortSha(value) {
  return value ? String(value).slice(0, 7) : null;
}

function normalizeWorktreeReconcileEvent(ev) {
  const ok = ev.ok === true;
  return {
    type: "worktree_reconcile",
    text: ev.message || (ok ? "Worktree merge recorded." : "Worktree merge paused."),
    tone: ok ? "success" : "warn",
    status: ev.status || null,
    branch: ev.branch || null,
    sourceHeadBefore: shortSha(ev.sourceHeadBefore),
    sourceHeadAfter: shortSha(ev.sourceHeadAfter),
    branchHead: shortSha(ev.branchHead),
  };
}

function eventTarget(ev) {
  return ev?.type === "sdk_event" && ev.event ? ev.event : ev;
}

function followedByMatchingStructuredOutput(events, index) {
  const target = eventTarget(events[index]);
  const value = structuredOutputValue(target);
  if (target?.type !== "result" || value === undefined) return false;
  const nextTarget = eventTarget(events[index + 1]);
  if (nextTarget?.type !== "structured_output") return false;
  const nextValue = nextTarget.value ?? nextTarget.structured_output ?? nextTarget.result;
  return structuredOutputKey(value) === structuredOutputKey(nextValue);
}

const HIDDEN_CLI_EVENT_TYPES = new Set([
  "hook_started",
  "hook_response",
  "init",
  "rate_limit_event",
]);

// Provider housekeeping subtypes. The worker drops these before they are
// persisted (src/worker/event-coalescer.js); this filter keeps already-recorded
// runs readable. Matched only against `type: "system"` so an unrelated provider
// event that happens to carry `subtype: "status"` stays visible.
const HIDDEN_SYSTEM_SUBTYPES = new Set([
  "commands_changed",
  "hook_started",
  "hook_response",
  "init",
  "status",
  "thinking_tokens",
]);

function isHiddenSystemEvent(ev) {
  return ev?.type === "system" && HIDDEN_SYSTEM_SUBTYPES.has(ev.subtype);
}

function providerPayload(ev) {
  const target = ev?.type === "sdk_event" ? ev.event : ev;
  if (target?.type === "cli_event" && target.raw) return target.raw;
  return target;
}

function thinkingTokensFromEvent(ev) {
  const payload = providerPayload(ev);
  if (payload?.type !== "system" || payload.subtype !== "thinking_tokens") return null;
  const total = Number(payload.estimated_tokens);
  return Number.isFinite(total) ? total : null;
}

function attachThinkingTokens(ev, tokens) {
  const content = ev?.message?.content || ev?.content;
  if (!Array.isArray(content)) return ev;
  let consumed = false;
  const next = content.map((block) => {
    if (!isRedactedThinkingBlock(block)) return block;
    const estimated = consumed || !(tokens > 0) ? (block.estimated_tokens ?? null) : tokens;
    consumed = true;
    return { type: "thinking", text: "", redacted: true, estimated_tokens: estimated };
  });
  if (ev.message?.content) return { ...ev, message: { ...ev.message, content: next } };
  return { ...ev, content: next };
}

// A finalized thinking block supersedes the progress row that preceded it, and
// only the latest of a run of progress rows is worth showing.
function collapseThinkingProgress(rows) {
  const collapsed = [];
  for (const row of rows) {
    const last = collapsed[collapsed.length - 1];
    if (row?.type === "thinking_progress") {
      if (last?.type === "thinking_progress") collapsed[collapsed.length - 1] = row;
      else collapsed.push(row);
      continue;
    }
    if (last?.type === "thinking_progress" && hasRedactedThinkingBlock(row)) collapsed.pop();
    collapsed.push(row);
  }
  return collapsed;
}

function normalizeCliEvent(ev) {
  const raw = ev?.raw;
  if (!raw) return ev;
  const codexItem = normalizeCodexItemEvent(raw);
  if (codexItem) return codexItem;
  if (HIDDEN_CLI_EVENT_TYPES.has(raw.type) || HIDDEN_CLI_EVENT_TYPES.has(raw.subtype)) return null;
  if (isHiddenSystemEvent(raw)) return null;
  if (raw.type === "error") {
    return { type: "error", message: raw.message || raw.error || "CLI error" };
  }
  if (raw.type === "result") {
    const usage = raw.usage || {};
    const parts = [
      usage.input_tokens != null ? `in ${usage.input_tokens}` : null,
      usage.output_tokens != null ? `out ${usage.output_tokens}` : null,
      raw.duration_ms != null ? `${raw.duration_ms}ms` : null,
      raw.num_turns != null ? `${raw.num_turns} turns` : null,
    ].filter(Boolean);
    return { type: "result", text: parts.length ? parts.join(" / ") : "Completed" };
  }
  return ev;
}

function normalizeWorklabEvent(ev, { compactFinal = false } = {}) {
  if (!ev) return null;
  if (ev.type === "sdk_event") return normalizeWorklabEvent(ev.event, { compactFinal });
  if (ev.type === "live_user_message") {
    return {
      type: "live_user_message",
      text: ev.body || ev.text || "",
      created_at: ev.created_at || null,
    };
  }
  if (ev.type === "worklab_result_candidate") return null;
  if (isHiddenSystemEvent(ev)) return null;
  if (ev.type === "worklab_result_error") return { type: "error", message: ev.message || "Invalid worklab_result" };
  if (isStandaloneWorklabResultTextEvent(ev)) return null;
  if (ev.type === "worktree_reconcile") return normalizeWorktreeReconcileEvent(ev);
  if (ev.type === "structured_output") {
    return normalizeStructuredOutputEvent(ev);
  }
  const codexItem = normalizeCodexItemEvent(ev);
  if (codexItem) return codexItem;
  if (ev.type === "cli_event") return normalizeCliEvent(ev);
  if (ev.type === "final") {
    const usage = formatFinalUsage(ev);
    if (compactFinal) {
      return {
        type: "final",
        compact: true,
        text: ev.text || "",
        summary: usage,
        usage: ev.usage || {},
        model: ev.model,
        durationMs: ev.durationMs,
        numTurns: ev.numTurns,
      };
    }
    const text = formatFinalText(ev);
    return {
      type: "final",
      text: usage ? `${text}\n\n${usage}` : text,
      ...(ev.worklab_result ? { structured: ev.worklab_result } : {}),
    };
  }
  if (ev.type === "result") {
    const resultError = providerResultErrorMessage(ev);
    if (resultError) return { type: "error", message: resultError };
    const outputValue = structuredOutputValue(ev);
    if (outputValue !== undefined) {
      return normalizeStructuredOutputEvent({
        source: "claude_sdk_output_format",
        value: outputValue,
        worklab_result: structuredWorklabResult(outputValue),
      });
    }
    const usage = ev.usage || {};
    const parts = [
      usage.input_tokens != null ? `in ${usage.input_tokens}` : null,
      usage.output_tokens != null ? `out ${usage.output_tokens}` : null,
      ev.duration_ms != null ? `${ev.duration_ms}ms` : null,
      ev.num_turns != null ? `${ev.num_turns} turns` : null,
    ].filter(Boolean);
    return {
      ...ev,
      text: parts.length ? parts.join(" / ") : "Completed",
      ...(
        ev.worklab_result || (ev.result && typeof ev.result === "object")
          ? { structured: ev.worklab_result || ev.result }
          : {}
      ),
    };
  }
  return ev;
}

export function normalizeWorklabEvents(events = []) {
  const visibleTexts = new Set();
  let visibleTextTail = "";
  let thinkingTokens = 0;
  const rows = events.map((event, index) => {
    // Hidden thinking-token estimates still carry the only reasoning signal the
    // provider sends, so keep the running total for the block that follows.
    const tokens = thinkingTokensFromEvent(event);
    if (tokens != null) {
      thinkingTokens = tokens;
      return null;
    }
    if (followedByMatchingStructuredOutput(events, index)) return null;
    const rawFinalText = String(event?.text || "").trim();
    const normalizedFinalText = normalizeCommentText(rawFinalText);
    const compactFinal = event?.type === "final" && (
      normalizedFinalText
        ? visibleTexts.has(normalizedFinalText)
        : visibleTexts.size > 0
    );
    let normalized = normalizeWorklabEvent(event, {
      compactFinal,
    });
    if (!normalized) return null;
    if (hasRedactedThinkingBlock(normalized)) {
      normalized = attachThinkingTokens(normalized, thinkingTokens);
      thinkingTokens = 0;
    }
    const visibleText = normalizeCommentText(visibleTextFromEvent(event));
    if (visibleText) {
      visibleTextTail = isVisibleTextEvent(event)
        ? mergeVisibleText(visibleTextTail, visibleText)
        : visibleText;
      visibleTexts.add(visibleText);
      visibleTexts.add(visibleTextTail);
    } else if (!isVisibleTextEvent(event)) {
      visibleTextTail = "";
    }
    return normalized;
  }).filter(Boolean);
  return collapseThinkingProgress(rows);
}

export function EventTimeline({ events, streaming = false }) {
  const normalized = useMemo(() => normalizeWorklabEvents(events), [events]);
  if (!events.length) return <div class="meta">{streaming ? "Waiting for first agent event..." : "No events yet."}</div>;
  return (
    <AgentEventTimeline
      events={normalized}
      streaming={streaming}
    />
  );
}
