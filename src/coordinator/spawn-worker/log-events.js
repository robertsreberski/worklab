import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const CONTEXT_BLOAT_TOP_EVENTS = 5;
export const RAW_RESULT_STORAGE_LIMIT = 4_000;

export function makeRawLogPath(dataDir, runId) {
  if (!dataDir || !runId) return null;
  const dir = join(dataDir, "logs", "runs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runId}.jsonl`);
}

function truncateString(value, { limit }) {
  if (!limit || limit < 1 || typeof value !== "string" || value.length <= limit) {
    return { value, truncated: false, originalLength: value?.length || 0 };
  }
  const marker = `\n\n[truncated ${value.length - limit} chars; full raw log available]`;
  return {
    value: `${value.slice(0, limit)}${marker}`,
    truncated: true,
    originalLength: value.length,
  };
}

function truncateToolResultValue(value, options) {
  if (typeof value === "string") return truncateString(value, options);
  if (Array.isArray(value)) {
    let truncated = false;
    let originalLength = 0;
    const next = value.map((item) => {
      if (item?.type === "text" && typeof item.text === "string") {
        const result = truncateString(item.text, options);
        truncated ||= result.truncated;
        originalLength = Math.max(originalLength, result.originalLength);
        return result.truncated ? { ...item, text: result.value } : item;
      }
      return item;
    });
    return { value: next, truncated, originalLength };
  }
  return { value, truncated: false, originalLength: 0 };
}

function truncateStructuredDisplayValue(value, options) {
  if (!options.limit || options.limit < 1 || value == null) {
    return { value, truncated: false, originalLength: 0 };
  }
  if (typeof value === "string") return truncateString(value, options);
  let raw;
  try {
    raw = JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  if (raw.length <= options.limit) return { value, truncated: false, originalLength: raw.length };
  const clipped = truncateString(raw, options);
  return {
    value: {
      truncated: true,
      original_length: raw.length,
      raw_output_path: options.rawLogPath || null,
      preview: clipped.value,
    },
    truncated: true,
    originalLength: raw.length,
  };
}

function compactStructuredStorageValue(value, options = {}) {
  const limit = options.limit || RAW_RESULT_STORAGE_LIMIT;
  if (!limit || limit < 1 || value == null) {
    return { value, truncated: false, originalLength: 0 };
  }
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (raw.length <= limit) return { value, truncated: false, originalLength: raw.length };
  return {
    value: {
      truncated: true,
      original_length: raw.length,
      preview: `${raw.slice(0, limit)}\n[truncated stored raw_result]`,
    },
    truncated: true,
    originalLength: raw.length,
  };
}

function compactStorageToolResultBlock(block, options) {
  if (!block || typeof block !== "object" || block.type !== "tool_result" || !("raw_result" in block)) return block;
  const clipped = compactStructuredStorageValue(block.raw_result, options);
  if (!clipped.truncated) return block;
  return {
    ...block,
    raw_result: clipped.value,
    raw_result_truncated: true,
    raw_result_original_length: clipped.originalLength,
  };
}

export function compactStorageEvent(event, options = {}) {
  if (!event) return event;
  const next = JSON.parse(JSON.stringify(event));
  const target = next.type === "sdk_event" && next.event ? next.event : next;
  if (Array.isArray(target?.message?.content)) {
    target.message.content = target.message.content.map((block) => compactStorageToolResultBlock(block, options));
  }
  if (target?.type === "tool_result") {
    const clipped = compactStorageToolResultBlock(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
  }
  return next;
}

function truncateToolUseBlock(block, options) {
  if (!block || typeof block !== "object" || block.type !== "tool_use" || !("input" in block)) return block;
  const clipped = truncateStructuredDisplayValue(block.input, options);
  if (!clipped.truncated) return block;
  return {
    ...block,
    input: clipped.value,
    input_truncated: true,
    input_original_length: clipped.originalLength,
    raw_output_path: options.rawLogPath || null,
  };
}

function truncateToolResultBlock(block, options) {
  if (!block || typeof block !== "object" || block.type !== "tool_result") return block;
  let next = block;
  let truncated = false;
  let originalLength = 0;
  for (const key of ["content", "output", "result"]) {
    if (!(key in next)) continue;
    const clipped = truncateToolResultValue(next[key], options);
    if (clipped.truncated) {
      next = { ...next, [key]: clipped.value };
      truncated = true;
      originalLength = Math.max(originalLength, clipped.originalLength);
    }
  }
  if ("raw_result" in next) {
    const clipped = truncateStructuredDisplayValue(next.raw_result, options);
    if (clipped.truncated) {
      next = { ...next, raw_result: clipped.value };
      truncated = true;
      originalLength = Math.max(originalLength, clipped.originalLength);
    }
  }
  if (!truncated) return next;
  return {
    ...next,
    truncated: true,
    original_length: originalLength,
    raw_output_path: options.rawLogPath || null,
  };
}

// A subagent's tool call reaches us as a flat `subagent_activity` payload, not
// as message content, so the block-based clippers above never see it. Its
// `content` already arrives bounded from the runtime; `arguments` carries the
// child's raw tool input and can be arbitrarily large (a Write of a whole file).
function truncateSubagentActivity(target, options) {
  if (target?.type !== "subagent_activity" || !("arguments" in target)) return target;
  const clipped = truncateStructuredDisplayValue(target.arguments, options);
  if (!clipped.truncated) return target;
  return {
    ...target,
    arguments: clipped.value,
    arguments_truncated: true,
    arguments_original_length: clipped.originalLength,
    raw_output_path: options.rawLogPath || null,
  };
}

export function truncateDisplayEvent(event, options) {
  if (!event || !options.limit || options.limit < 1) return event;
  const next = JSON.parse(JSON.stringify(event));
  const target = next.type === "sdk_event" && next.event ? next.event : next;
  if (target?.type === "subagent_activity") {
    const clipped = truncateSubagentActivity(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
    return next;
  }
  if (Array.isArray(target?.message?.content)) {
    target.message.content = target.message.content
      .map((block) => truncateToolUseBlock(block, options))
      .map((block) => truncateToolResultBlock(block, options));
  }
  if (target?.type === "tool_use") {
    const clipped = truncateToolUseBlock(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
  }
  if (target?.type === "tool_result") {
    const clipped = truncateToolResultBlock(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
  }
  return next;
}

export function jsonCharLength(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return String(value || "").length;
  }
}

export function contentBlocksFromEvent(rawEvent) {
  const target = rawEvent?.type === "sdk_event" && rawEvent.event ? rawEvent.event : rawEvent;
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

export function insertTopByChars(list, item, limit = CONTEXT_BLOAT_TOP_EVENTS) {
  list.push(item);
  list.sort((a, b) => (b.chars || b.payload_chars || 0) - (a.chars || a.payload_chars || 0));
  if (list.length > limit) list.length = limit;
}

export function isBroadGlobUse(block) {
  if (block?.type !== "tool_use" || block.name !== "Glob") return false;
  const input = block.input || {};
  const pattern = String(input.pattern || "");
  const targetPath = String(input.path || "");
  return pattern === "**/*" || pattern === "**" || (pattern.includes("**") && !targetPath.includes("src"));
}
