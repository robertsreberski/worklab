import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function parseJson(value, fallback = null) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function usageInt(usage, key) {
  return Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : null;
}

export function usageNumber(usage, key) {
  return Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : null;
}

export function rawLogPath(dataDir, runId) {
  const dir = join(dataDir, "logs", "assistant");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runId}.jsonl`);
}

export function eventLimit(value) {
  const parsed = Number(value || 200);
  if (!Number.isInteger(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 500);
}

function truncateText(value, { limit, rawLogPath: path, label }) {
  const text = String(value || "");
  if (!limit || text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n[truncated ${label}: ${omitted} chars omitted; raw log: ${path || "unavailable"}]`;
}

function jsonSize(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return Infinity;
  }
}

function truncateSubagentActivity(event, { limit, rawLogPath: path }) {
  if (event?.type !== "subagent_activity" || !("arguments" in event)) return event;
  const value = event.arguments;
  if (value === undefined) return event;
  let raw = value;
  let size = typeof value === "string" ? value.length : 0;
  if (typeof value !== "string") {
    try {
      raw = JSON.stringify(value, null, 2);
      if (typeof raw !== "string") return event;
      size = raw.length;
    } catch {
      return {
        ...event,
        arguments: "[assistant subagent arguments unavailable: value is not JSON-serializable]",
        arguments_truncated: true,
        arguments_serialization_error: true,
        raw_output_path: path || null,
      };
    }
  }
  if (!limit || size <= limit) return event;
  const preview = truncateText(raw, {
    limit,
    rawLogPath: path,
    label: "assistant subagent arguments",
  });
  return {
    ...event,
    arguments: typeof value === "string"
      ? preview
      : {
          truncated: true,
          original_length: size,
          raw_output_path: path || null,
          preview,
        },
    arguments_truncated: true,
    arguments_original_length: size,
    raw_output_path: path || null,
  };
}

export function truncateAssistantEvent(event, { limit = 12_000, rawLogPath: path } = {}) {
  const boundedEvent = truncateSubagentActivity(event, { limit, rawLogPath: path });
  const content = boundedEvent?.message?.content;
  if (!Array.isArray(content)) return boundedEvent;
  let changed = false;
  const nextContent = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type !== "tool_result" && block.type !== "tool_use") return block;
    const next = { ...block };
    if (typeof next.content === "string") {
      const truncated = truncateText(next.content, { limit, rawLogPath: path, label: "assistant tool result" });
      if (truncated !== next.content) {
        next.content = truncated;
        changed = true;
      }
    } else if (next.content != null) {
      const size = jsonSize(next.content);
      if (size > limit) {
        next.content = `[truncated assistant tool result: ${size} JSON chars; raw log: ${path || "unavailable"}]`;
        changed = true;
      }
    }
    for (const key of ["raw_result", "input"]) {
      const size = jsonSize(next[key]);
      if (size > limit) {
        next[key] = { truncated: true, original_json_chars: size, raw_log_path: path || null };
        changed = true;
      }
    }
    return next;
  });
  return changed
    ? { ...boundedEvent, message: { ...boundedEvent.message, content: nextContent } }
    : boundedEvent;
}

export function warningRows(events = [], extras = []) {
  const rows = [];
  for (const event of events) {
    if (event?.type !== "runtime_warning") continue;
    rows.push({
      kind: event.warning_kind || "runtime",
      source: event.source || null,
      message: typeof event.message === "string" ? event.message : "",
      ts: event.ts || Date.now(),
    });
  }
  for (const warning of extras || []) {
    if (!warning) continue;
    rows.push({
      kind: warning.warning_kind || warning.kind || "runtime",
      source: warning.source || null,
      message: typeof warning.message === "string" ? warning.message : "",
      ts: warning.ts || Date.now(),
    });
  }
  return rows;
}
