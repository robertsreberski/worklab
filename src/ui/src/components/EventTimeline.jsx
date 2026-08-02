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
  let target = ev;
  while (target?.type === "sdk_event" && target.event) target = target.event;
  return target;
}

const ACP_PLAN_UPDATE_TYPES = new Set(["plan", "plan_update", "plan_removed"]);
const ACP_PROVIDER_EVENT_TYPES = new Set([
  "provider_request_started",
  "provider_request_completed",
  "provider_failover_started",
  "provider_failover_completed",
  "provider_status",
]);

function boundedAcpText(value, max = 500) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, max);
}

function acpIdentifier(value, max = 128) {
  return boundedAcpText(value, max).replace(/[^a-zA-Z0-9._:-]/gu, "");
}

function acpUpdateBody(event) {
  const target = eventTarget(event);
  const candidate = target?.update;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  if (candidate.sessionUpdate) return candidate;
  if (candidate.update?.sessionUpdate) return candidate.update;
  return candidate;
}

function acpUpdateType(event) {
  const target = eventTarget(event);
  const body = acpUpdateBody(target);
  return acpIdentifier(body.sessionUpdate || target?.updateType || target?.update_type) || "unknown";
}

function acpUpdateLabel(value) {
  const identifier = acpIdentifier(value) || "unknown";
  return identifier.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function finiteAcpNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function acpCost(value) {
  if (typeof value === "number" && Number.isFinite(value)) return { amount: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = finiteAcpNumber(value.amount);
  if (amount == null) return null;
  const currency = acpIdentifier(value.currency, 16);
  return { amount, ...(currency ? { currency } : {}) };
}

function acpPlanEntries(update) {
  const candidates = Array.isArray(update?.entries)
    ? update.entries
    : Array.isArray(update?.plan?.entries)
      ? update.plan.entries
      : Array.isArray(update?.plan)
        ? update.plan
        : update?.entry
          ? [update.entry]
          : [];
  return candidates.slice(0, 50).map((entry) => {
    const content = boundedAcpText(entry?.content, 2_000);
    const priority = acpIdentifier(entry?.priority, 32);
    const status = acpIdentifier(entry?.status, 32);
    return {
      ...(content ? { content } : {}),
      ...(priority ? { priority } : {}),
      ...(status ? { status } : {}),
    };
  }).filter((entry) => Object.keys(entry).length > 0);
}

function normalizeAcpPlan(update, fallbackType = "plan") {
  const action = ACP_PLAN_UPDATE_TYPES.has(update?.sessionUpdate)
    ? update.sessionUpdate
    : ACP_PLAN_UPDATE_TYPES.has(fallbackType)
      ? fallbackType
      : "plan";
  const titles = {
    plan: "ACP plan updated",
    plan_update: "ACP plan updated",
    plan_removed: "ACP plan removed",
  };
  return {
    type: "acp_plan",
    action,
    title: titles[action],
    entries: acpPlanEntries(update),
  };
}

function normalizeAcpContextUsage(event) {
  const source = event?.sessionUpdate === "usage_update" ? event : event?.context || {};
  const used = finiteAcpNumber(source.used);
  const window = finiteAcpNumber(source.window ?? source.size);
  const cost = acpCost(event?.cost);
  return {
    type: "acp_context_usage",
    ...(used != null ? { used } : {}),
    ...(window != null ? { window } : {}),
    ...(cost ? { cost } : {}),
  };
}

function acpDisplayItems(entries) {
  return entries
    .filter((entry) => entry?.label)
    .slice(0, 50)
    .map((entry) => ({
      label: boundedAcpText(entry.label, 160),
      ...(entry.detail ? { detail: boundedAcpText(entry.detail, 500) } : {}),
    }));
}

function normalizeRawAcpSessionUpdate(event) {
  const body = acpUpdateBody(event);
  const updateType = acpUpdateType(event);
  if (ACP_PLAN_UPDATE_TYPES.has(updateType)) return normalizeAcpPlan(body, updateType);
  if (updateType === "usage_update") return normalizeAcpContextUsage(body);

  if (updateType === "agent_message_chunk") {
    const text = body.content?.type === "text" ? boundedAcpText(body.content.text, 10_000) : "";
    if (text) return { type: "text", text };
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP agent message updated",
      detail: "Non-text message content was not displayed.",
    };
  }
  if (updateType === "agent_thought_chunk") {
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP agent reasoning updated",
      detail: "Private reasoning content was not displayed.",
    };
  }
  if (updateType === "user_message_chunk") {
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP user message updated",
      detail: "User message content was not repeated in the event log.",
    };
  }
  if (updateType === "tool_call" || updateType === "tool_call_update") {
    const toolTitle = boundedAcpText(body.title || body.name, 200);
    const kind = acpIdentifier(body.kind, 64);
    const status = acpIdentifier(body.status, 64);
    return {
      type: "acp_session_update",
      updateType,
      title: updateType === "tool_call" ? "ACP tool call started" : "ACP tool call updated",
      items: acpDisplayItems([
        toolTitle ? { label: "Tool", detail: toolTitle } : null,
        kind ? { label: "Kind", detail: acpUpdateLabel(kind) } : null,
        status ? { label: "Status", detail: acpUpdateLabel(status) } : null,
      ]),
    };
  }
  if (updateType === "available_commands_update") {
    const commands = Array.isArray(body.availableCommands)
      ? body.availableCommands
      : Array.isArray(body.commands)
        ? body.commands
        : [];
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP commands updated",
      items: acpDisplayItems(commands.map((command) => ({
        label: boundedAcpText(command?.name, 160),
        detail: [
          boundedAcpText(command?.description, 300),
          boundedAcpText(command?.input?.hint || command?.inputHint, 160),
        ].filter(Boolean).join(" · "),
      }))),
    };
  }
  if (updateType === "current_mode_update") {
    const mode = acpIdentifier(body.currentModeId || body.modeId, 160);
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP session mode updated",
      ...(mode ? { detail: `Mode: ${mode}` } : {}),
    };
  }
  if (updateType === "config_option_update") {
    const options = Array.isArray(body.configOptions) ? body.configOptions : [];
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP configuration options updated",
      items: acpDisplayItems(options.map((option) => ({
        label: boundedAcpText(option?.name || option?.label || option?.id, 160),
        detail: acpIdentifier(option?.type, 32),
      }))),
    };
  }
  if (updateType === "session_info_update") {
    const title = boundedAcpText(body.title, 300);
    const updatedAt = boundedAcpText(body.updatedAt, 80);
    return {
      type: "acp_session_update",
      updateType,
      title: "ACP session information updated",
      items: acpDisplayItems([
        { label: "Title", detail: title },
        { label: "Updated", detail: updatedAt },
      ]),
    };
  }
  return {
    type: "acp_session_update",
    updateType,
    title: `ACP session update: ${acpUpdateLabel(updateType)}`,
  };
}

function providerReference(value) {
  if (typeof value === "string") return boundedAcpText(value, 256);
  if (!value || typeof value !== "object") return "";
  return boundedAcpText(value.reference || value.model || value.id, 256);
}

function isAcpProviderEvent(event) {
  if (!ACP_PROVIDER_EVENT_TYPES.has(event?.type)) return false;
  if (event.source === "acp" || event.sdk === "acp" || event.runtime === "acp-stdio") return true;
  return [event.model, event.from, event.to].some((value) => providerReference(value).startsWith("acp:"));
}

function normalizeAcpProviderEvent(event) {
  const type = event.type;
  const durationMs = finiteAcpNumber(event.durationMs);
  const model = providerReference(event.model);
  if (type === "provider_status") {
    const kind = acpIdentifier(event.kind, 64) || "unknown";
    if (kind === "request_started" || kind === "request_completed") {
      return {
        type: `provider_${kind}`,
        sdk: "acp",
        ...(model ? { model } : {}),
        ...(kind === "request_completed" && durationMs != null ? { durationMs } : {}),
        ...(kind === "request_completed" ? { cancelled: event.cancelled === true } : {}),
      };
    }
    if (kind === "failover_started" || kind === "failover_completed") {
      const from = providerReference(event.from);
      const to = providerReference(event.to || event.model);
      return {
        type: `provider_${kind}`,
        ...(from ? { from: { model: from } } : {}),
        ...(to ? { to: { model: to } } : {}),
      };
    }
    return {
      type: "acp_provider_status",
      status: kind,
      title: kind === "retry_started" ? "Retrying ACP provider" : `ACP provider: ${acpUpdateLabel(kind)}`,
      ...(finiteAcpNumber(event.retryIndex) != null ? { retryIndex: event.retryIndex } : {}),
      ...(finiteAcpNumber(event.attemptIndex) != null ? { attemptIndex: event.attemptIndex } : {}),
    };
  }
  if (type === "provider_failover_started" || type === "provider_failover_completed") {
    const from = providerReference(event.from);
    const to = providerReference(event.to || event.model);
    return {
      type,
      ...(from ? { from: { model: from } } : {}),
      ...(to ? { to: { model: to } } : {}),
    };
  }
  return {
    type,
    sdk: "acp",
    ...(model ? { model } : {}),
    ...(type === "provider_request_completed" && durationMs != null ? { durationMs } : {}),
    ...(type === "provider_request_completed" ? { cancelled: event.cancelled === true } : {}),
  };
}

function normalizeAcpInteractionEvent(event) {
  const suffix = acpIdentifier(event.type, 128).replace(/^acp_interaction_/, "") || "updated";
  const titles = {
    requested: "ACP interaction requested",
    acknowledged: "ACP interaction acknowledged",
    submitted: "ACP interaction submitted",
    resolved: "ACP interaction resolved",
    cancelled: "ACP interaction cancelled",
  };
  const detail = [event.interaction_kind, event.state, event.disposition, event.outcome]
    .map((value) => acpIdentifier(value, 64))
    .filter(Boolean)
    .map(acpUpdateLabel)
    .join(" · ");
  return {
    type: "acp_interaction",
    action: suffix,
    title: titles[suffix] || `ACP interaction: ${acpUpdateLabel(suffix)}`,
    ...(detail ? { detail } : {}),
  };
}

function isAcpTimelineEvent(event) {
  const target = eventTarget(event);
  if (!target) return false;
  if (target.type === "acp_session_update" || String(target.type || "").startsWith("acp_interaction_")) return true;
  if (target.type === "plan" && target.source === "acp") return true;
  if (target.type === "context_usage" && target.source === "acp") return true;
  if (target.type === "capabilities_resolved" && target.sdk === "acp") return true;
  if (isAcpProviderEvent(target)) return true;
  return String(target.type || "").startsWith("acp_");
}

export function normalizeAcpTimelineEvent(event) {
  const target = eventTarget(event);
  if (target.type === "acp_session_update") return normalizeRawAcpSessionUpdate(target);
  if (target.type === "plan" && target.source === "acp") return normalizeAcpPlan(target.update || {}, target.update?.sessionUpdate);
  if (target.type === "context_usage" && target.source === "acp") return normalizeAcpContextUsage(target);
  if (isAcpProviderEvent(target)) return normalizeAcpProviderEvent(target);
  if (String(target.type || "").startsWith("acp_interaction_")) return normalizeAcpInteractionEvent(target);
  if (target.type === "capabilities_resolved" && target.sdk === "acp") {
    return {
      type: "acp_session_update",
      updateType: "capabilities_resolved",
      title: "ACP capabilities negotiated",
    };
  }
  const updateType = acpIdentifier(target.type, 128) || "unknown";
  return {
    type: "acp_session_update",
    updateType,
    title: `ACP event: ${acpUpdateLabel(updateType)}`,
  };
}

function isAcpNormalizedCompanion(events, index) {
  const previous = eventTarget(events[index - 1]);
  const current = eventTarget(events[index]);
  if (previous?.type !== "acp_session_update" || !current) return false;
  const body = acpUpdateBody(previous);
  const updateType = acpUpdateType(previous);
  const content = current.message?.content || current.content;
  if (updateType === "agent_message_chunk") return current.type === "assistant" && Array.isArray(content);
  if (updateType === "agent_thought_chunk") return current.type === "assistant" && Array.isArray(content);
  if (updateType === "tool_call") {
    return current.type === "assistant"
      && Array.isArray(content)
      && content.some((block) => block?.type === "tool_use" && block.id === body.toolCallId);
  }
  if (updateType === "tool_call_update" && ["completed", "failed"].includes(body.status)) {
    return current.type === "user"
      && Array.isArray(content)
      && content.some((block) => block?.type === "tool_result" && block.tool_use_id === body.toolCallId);
  }
  if (updateType === "usage_update") return current.type === "context_usage" && current.source === "acp";
  if (ACP_PLAN_UPDATE_TYPES.has(updateType)) return current.type === "plan" && current.source === "acp";
  return false;
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

// agent-runtime 0.15.0 emits codex file changes as a flat `file_change` event
// rather than the synthetic file_edit tool_use/tool_result pair the timeline
// renders. Re-wrap it so ToolToken keeps its single file_edit rendering path.
function codexItemEvent(raw) {
  const item = normalizeCodexItemEvent(raw);
  if (item?.type !== "file_change") return item;
  const payload = {
    changes: item.changes,
    status: item.status,
    ...(item.summary ? { summary: item.summary } : {}),
  };
  if (item.status !== "completed") {
    return {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: item.id, name: "file_edit", input: payload }] },
    };
  }
  return {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: item.id,
        content: item.error || payload,
        is_error: Boolean(item.is_error),
      }],
    },
  };
}

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
  const codexItem = codexItemEvent(raw);
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
  if (isAcpTimelineEvent(ev)) return normalizeAcpTimelineEvent(ev);
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
  const codexItem = codexItemEvent(ev);
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
    // ACP emits a raw protocol update followed by a convenience event. Keep
    // the strict display projection of the protocol update and discard the
    // companion, which can carry raw tool input/output or private reasoning.
    if (isAcpNormalizedCompanion(events, index)) return null;
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
    const originalVisibleText = visibleTextFromEvent(event);
    const visibleSource = originalVisibleText ? event : normalized;
    const visibleText = normalizeCommentText(originalVisibleText || visibleTextFromEvent(normalized));
    if (visibleText) {
      visibleTextTail = isVisibleTextEvent(visibleSource)
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
