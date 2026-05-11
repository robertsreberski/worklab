export const SQLITE_LOG_COMPACTION_STRATEGY = "slim-db";
export const SQLITE_LOG_COMPACTION_VERSION = 2;

export const DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS = {
  keepEvents: 200,
  maxEventBytes: 16 * 1024,
  maxLogBytes: 0,
  maxTextChars: 4000,
  previewChars: 320,
};

const TOOL_USE_TYPES = new Set(["tool_use", "toolCall"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "toolResult", "tool_output"]);
const TEXT_BLOCK_TYPES = new Set(["text", "thinking", "reasoning"]);
const TOOL_METADATA_KEYS = [
  "type",
  "id",
  "tool_use_id",
  "toolCallId",
  "tool_call_id",
  "name",
  "toolName",
  "display_name",
  "displayName",
  "source_tool_use_id",
  "status",
  "is_error",
  "isError",
  "error",
  "ts",
  "_event_seq",
];

function optionsWithDefaults(options = {}) {
  return {
    ...DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS,
    ...options,
    keepEvents: Math.max(1, Number(options.keepEvents ?? DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.keepEvents) || DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.keepEvents),
    maxEventBytes: Math.max(0, Number(options.maxEventBytes ?? DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxEventBytes) || 0),
    maxLogBytes: Math.max(0, Number(options.maxLogBytes ?? DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxLogBytes) || 0),
    maxTextChars: Math.max(80, Number(options.maxTextChars ?? DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxTextChars) || DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxTextChars),
    previewChars: Math.max(40, Number(options.previewChars ?? DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.previewChars) || DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.previewChars),
  };
}

function jsonClone(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null));
  } catch {
    return Buffer.byteLength(String(value ?? ""));
  }
}

function stringifyValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function oneLine(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function payloadSummary(value, options) {
  const raw = stringifyValue(value);
  return {
    preview: oneLine(raw, options.previewChars),
    bytes: Buffer.byteLength(raw),
  };
}

function capString(value, options) {
  if (typeof value !== "string" || value.length <= options.maxTextChars) return value;
  const omitted = value.length - options.maxTextChars;
  return `${value.slice(0, options.maxTextChars).trimEnd()}\n[truncated ${omitted} chars; full raw log available]`;
}

function capStringsDeep(value, options) {
  if (typeof value === "string") return capString(value, options);
  if (Array.isArray(value)) return value.map((item) => capStringsDeep(item, options));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = capStringsDeep(child, options);
  }
  return next;
}

function normalizedToolName(block = {}) {
  return String(block.name || block.toolName || "").split("__").filter(Boolean).at(-1) || "";
}

function isToolUseBlock(block) {
  return TOOL_USE_TYPES.has(block?.type);
}

function isToolResultBlock(block) {
  return TOOL_RESULT_TYPES.has(block?.type);
}

function isStructuredOutput(block) {
  return block?.type === "structured_output" || normalizedToolName(block) === "StructuredOutput";
}

function isFileEdit(block) {
  return normalizedToolName(block) === "file_edit";
}

function isTodoWrite(block) {
  return normalizedToolName(block) === "todo_write";
}

function copyMetadata(block = {}) {
  const next = {};
  for (const key of TOOL_METADATA_KEYS) {
    if (block[key] !== undefined) next[key] = block[key];
  }
  return next;
}

function compactLineStats(stats = {}, options) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return stats;
  const next = {};
  for (const key of ["before_lines", "after_lines", "added_lines", "removed_lines", "unavailable_reason"]) {
    if (stats[key] !== undefined) next[key] = capStringsDeep(stats[key], options);
  }
  if (Array.isArray(stats.hunks)) {
    next.hunks = stats.hunks.slice(0, 32).map((hunk) => {
      if (!hunk || typeof hunk !== "object") return hunk;
      const compact = {};
      for (const key of ["old_start", "old_lines", "new_start", "new_lines", "start", "lines"]) {
        if (hunk[key] !== undefined) compact[key] = hunk[key];
      }
      return compact;
    });
  }
  return next;
}

function compactFileEditPayload(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return capStringsDeep(payload, options);
  const next = {};
  for (const key of ["status", "source", "summary"]) {
    if (payload[key] !== undefined) next[key] = capStringsDeep(payload[key], options);
  }
  if (Array.isArray(payload.changes)) {
    next.changes = payload.changes.map((change) => {
      if (!change || typeof change !== "object") return change;
      const compact = {};
      for (const key of [
        "path",
        "display_path",
        "displayPath",
        "kind",
        "status",
        "source",
        "artifact_type",
        "artifact_relative_path",
        "temporary",
        "size_bytes",
        "href",
        "event_seq",
        "first_event_seq",
        "last_event_seq",
        "event_count",
      ]) {
        if (change[key] !== undefined) compact[key] = capStringsDeep(change[key], options);
      }
      if (change.line_stats !== undefined) compact.line_stats = compactLineStats(change.line_stats, options);
      return compact;
    });
  }
  return next;
}

function compactTodoInput(input, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return capStringsDeep(input, options);
  if (!Array.isArray(input.todos)) return {};
  return {
    todos: input.todos.map((todo) => {
      if (!todo || typeof todo !== "object") return todo;
      return {
        id: todo.id,
        content: capString(String(todo.content || ""), options),
        status: todo.status,
        priority: todo.priority,
      };
    }),
  };
}

function structuredPayload(value, options) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return capStringsDeep(value, options);
  const worklabResult = value.worklab_result?.schema === "worklab.v2" ? value.worklab_result : value.schema === "worklab.v2" ? value : null;
  if (worklabResult) return capStringsDeep(worklabResult, options);
  return capStringsDeep(value, options);
}

function attachPayloadPreview(next, key, value, options) {
  const summary = payloadSummary(value, options);
  next[`${key}_omitted`] = true;
  next[`${key}_omitted_bytes`] = summary.bytes;
  if (summary.preview) next[`${key}_preview`] = summary.preview;
}

function inputPayloadKey(block) {
  if ("input" in block) return "input";
  if ("arguments" in block) return "arguments";
  if ("arg" in block) return "arg";
  return null;
}

function outputPayloadKeys(block) {
  return ["content", "output", "result", "value", "raw_result"].filter((key) => key in block);
}

function compactToolUseBlock(block, options) {
  const next = copyMetadata(block);
  const payloadKey = inputPayloadKey(block);
  if (!payloadKey) return next;
  const payload = block[payloadKey];
  if (isFileEdit(block)) {
    next[payloadKey] = compactFileEditPayload(payload, options);
  } else if (isStructuredOutput(block)) {
    next[payloadKey] = structuredPayload(payload, options);
  } else if (isTodoWrite(block)) {
    next[payloadKey] = compactTodoInput(payload, options);
  } else {
    attachPayloadPreview(next, payloadKey, payload, options);
  }
  return next;
}

function compactToolResultBlock(block, options) {
  const next = copyMetadata(block);
  if (block.worklab_result !== undefined) next.worklab_result = structuredPayload(block.worklab_result, options);
  for (const key of outputPayloadKeys(block)) {
    const payload = block[key];
    if (isFileEdit(block) || (payload && typeof payload === "object" && Array.isArray(payload.changes))) {
      next[key] = compactFileEditPayload(payload, options);
    } else if (isStructuredOutput(block) || key === "value") {
      next[key] = structuredPayload(payload, options);
    } else {
      attachPayloadPreview(next, key, payload, options);
    }
  }
  return next;
}

function compactContentBlock(block, options) {
  if (!block || typeof block !== "object") return capStringsDeep(block, options);
  if (isToolUseBlock(block)) return compactToolUseBlock(block, options);
  if (isToolResultBlock(block)) return compactToolResultBlock(block, options);
  if (TEXT_BLOCK_TYPES.has(block.type)) return capStringsDeep(block, options);
  return capStringsDeep(block, options);
}

function compactEventObject(value, options) {
  if (!value || typeof value !== "object") return capStringsDeep(value, options);
  if (isToolUseBlock(value)) return compactToolUseBlock(value, options);
  if (isToolResultBlock(value)) return compactToolResultBlock(value, options);
  const next = jsonClone(value);
  if (next.type === "structured_output") {
    if (next.value !== undefined) next.value = structuredPayload(next.value, options);
    if (next.worklab_result !== undefined) next.worklab_result = structuredPayload(next.worklab_result, options);
  }
  if (next.worklab_result !== undefined) {
    next.worklab_result = structuredPayload(next.worklab_result, options);
  }
  if (Array.isArray(next?.message?.content)) {
    next.message.content = next.message.content.map((block) => compactContentBlock(block, options));
  }
  if (Array.isArray(next?.content)) {
    next.content = next.content.map((block) => compactContentBlock(block, options));
  }
  if (typeof next.text === "string") next.text = capString(next.text, options);
  if (typeof next.message === "string") next.message = capString(next.message, options);
  if (typeof next.body === "string") next.body = capString(next.body, options);
  if (typeof next.details === "string") next.details = capString(next.details, options);
  return next;
}

function eventFallback(event, bytes, options) {
  const target = event?.type === "sdk_event" && event.event ? event.event : event;
  const fallback = {
    type: event?.type || "event",
    _event_seq: event?._event_seq ?? target?._event_seq ?? null,
    ts: event?.ts ?? target?.ts ?? null,
    compacted: true,
    omitted_bytes: bytes,
    preview: oneLine(stringifyValue(event), options.previewChars),
  };
  if (target?.type) fallback.inner_type = target.type;
  if (target?.worklab_result?.schema === "worklab.v2") fallback.worklab_result = structuredPayload(target.worklab_result, options);
  return fallback;
}

export function compactEventForSqlite(event, options = {}) {
  const resolvedOptions = optionsWithDefaults(options);
  const next = jsonClone(event);
  let compacted;
  if (next?.type === "sdk_event" && next.event) {
    compacted = { ...next, event: compactEventObject(next.event, resolvedOptions) };
  } else if (next?.type === "cli_event" && next.raw) {
    compacted = { ...next, raw: compactEventObject(next.raw, resolvedOptions) };
  } else {
    compacted = compactEventObject(next, resolvedOptions);
  }
  const bytes = jsonByteLength(compacted);
  if (resolvedOptions.maxEventBytes && bytes > resolvedOptions.maxEventBytes) {
    return eventFallback(compacted, bytes, resolvedOptions);
  }
  return compacted;
}

export function compactEventsForSqlite(events = [], options = {}) {
  const resolvedOptions = optionsWithDefaults(options);
  const source = Array.isArray(events) ? events : [];
  const originalBytes = jsonByteLength(source);
  let compacted = source
    .slice(-resolvedOptions.keepEvents)
    .map((event) => compactEventForSqlite(event, resolvedOptions));
  if (resolvedOptions.maxLogBytes > 0) {
    while (compacted.length > 1 && jsonByteLength(compacted) > resolvedOptions.maxLogBytes) {
      compacted = compacted.slice(1);
    }
  }
  const compactedBytes = jsonByteLength(compacted);
  return {
    events: compacted,
    bytes: compactedBytes,
    original_count: source.length,
    original_bytes: originalBytes,
    kept_events: compacted.length,
    omitted_events: Math.max(0, source.length - compacted.length),
    strategy: SQLITE_LOG_COMPACTION_STRATEGY,
    version: SQLITE_LOG_COMPACTION_VERSION,
  };
}
