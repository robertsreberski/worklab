import { normalizePiBuiltinToolParams } from "../../agent/tools/pi-bridge.js";

export function streamContentKey(streamEvent, fallback) {
  return streamEvent?.contentIndex ?? fallback;
}

export function jsonSerializable(value, fallback = null) {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return fallback;
  }
}

function compactJsonPreview(value, { limit = 4000 } = {}) {
  let raw;
  try {
    raw = JSON.stringify(value || {});
  } catch {
    raw = String(value ?? "");
  }
  if (raw.length <= limit) return { value, truncated: false, originalLength: raw.length };
  return {
    value: {
      truncated: true,
      original_length: raw.length,
      preview: `${raw.slice(0, limit)}\n[truncated raw tool result]`,
    },
    truncated: true,
    originalLength: raw.length,
  };
}

export function compactToolRawResult(result, resultContent) {
  const raw = compactJsonPreview(result);
  const details = compactJsonPreview(result?.details || {});
  return {
    ...(raw.truncated ? {
      truncated: true,
      original_length: raw.originalLength,
      preview: raw.value.preview,
    } : {}),
    content: {
      omitted: true,
      reason: "already represented by tool_result.content",
      original_length: String(resultContent || "").length,
    },
    details: details.value,
    ...(details.truncated ? { details_truncated: true } : {}),
  };
}

export function eventToolArgs(toolName, args, { cwd, toolLimits } = {}) {
  return normalizePiBuiltinToolParams(toolName, args || {}, { cwd, toolLimits });
}

export function emitCaptured(events, onEvent, event) {
  if (!event) return;
  events.push(event);
  onEvent?.(event);
}
