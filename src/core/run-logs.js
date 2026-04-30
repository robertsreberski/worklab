import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getRunById } from "./db/queries/runs.js";
function runLogError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonlFromEvents(events = []) {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

function normalizeMode(value) {
  if (value === "full" || value === "tail") return value;
  return "summary";
}

function normalizeLimitBytes(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return 60_000;
  return Math.min(Math.max(n, 1_000), 5 * 1024 * 1024);
}

function tailString(content, limitBytes) {
  const buffer = Buffer.from(String(content || ""), "utf8");
  if (buffer.length <= limitBytes) {
    return {
      content: buffer.toString("utf8"),
      byte_length: buffer.length,
      returned_byte_length: buffer.length,
      offset_bytes: 0,
      truncated: false,
    };
  }
  const offset = buffer.length - limitBytes;
  return {
    content: buffer.subarray(offset).toString("utf8"),
    byte_length: buffer.length,
    returned_byte_length: limitBytes,
    offset_bytes: offset,
    truncated: true,
  };
}

function tailFile(filePath, limitBytes) {
  const stat = statSync(filePath);
  if (stat.size <= limitBytes) {
    const content = readFileSync(filePath, "utf8");
    return {
      content,
      byte_length: stat.size,
      returned_byte_length: Buffer.byteLength(content),
      offset_bytes: 0,
      truncated: false,
    };
  }
  const offset = stat.size - limitBytes;
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(limitBytes);
    const bytesRead = readSync(fd, buffer, 0, limitBytes, offset);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      byte_length: stat.size,
      returned_byte_length: bytesRead,
      offset_bytes: offset,
      truncated: true,
    };
  } finally {
    closeSync(fd);
  }
}

function parseJsonlEvents(content) {
  const out = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // Tail reads can start in the middle of a JSONL line. Ignore fragments.
    }
  }
  return out;
}

function oneLine(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function jsonLength(value) {
  try { return JSON.stringify(value)?.length || 0; } catch { return String(value || "").length; }
}

function eventTarget(event) {
  return event?.type === "sdk_event" && event.event ? event.event : event;
}

function eventBlocks(event) {
  const target = eventTarget(event);
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

function addCount(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topCounts(map, limit = 20) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function summarizeEvents(events = [], payload = {}) {
  const eventTypes = new Map();
  const innerTypes = new Map();
  const toolUseNames = new Map();
  const toolCalls = new Map();
  const toolResults = new Map();
  const largestToolResults = [];
  const warnings = [];
  const errors = [];
  const compactions = [];
  const finalMessages = [];

  function insertLargest(item) {
    largestToolResults.push(item);
    largestToolResults.sort((a, b) => (b.chars || 0) - (a.chars || 0));
    if (largestToolResults.length > 10) largestToolResults.length = 10;
  }

  for (const event of events) {
    const outerType = event?.type || "unknown";
    const target = eventTarget(event);
    const innerType = target?.type || null;
    addCount(eventTypes, outerType);
    addCount(innerTypes, innerType);

    if (outerType === "runtime_warning") {
      warnings.push({
        kind: event.warning_kind || "runtime",
        source: event.source || null,
        message: oneLine(event.message, 320),
      });
    }
    if (/context_compaction/.test(outerType)) {
      compactions.push({
        type: outerType,
        trigger: event.trigger || null,
        tokens_before: event.tokens_before || null,
        tokens_after: event.tokens_after || null,
      });
    }
    if (outerType === "final" || innerType === "final") {
      finalMessages.push(oneLine(event.text || target?.text || target?.message || "", 400));
    }
    if (event.error || target?.error || outerType === "error" || innerType === "error") {
      errors.push(oneLine(event.error || target?.error || event.message || target?.message || event, 400));
    }

    for (const block of eventBlocks(event)) {
      if (block?.type === "tool_use" || block?.type === "toolCall") {
        const name = block.name || block.toolName || "tool";
        addCount(toolCalls, name);
        if (block.id) toolUseNames.set(block.id, name);
      }
      if (block?.type === "tool_result" || block?.type === "toolResult") {
        const name = toolUseNames.get(block.tool_use_id || block.toolCallId) || block.name || block.toolName || "tool";
        addCount(toolResults, name);
        const content = block.content ?? block.output ?? block.result ?? "";
        const chars = jsonLength(content) + jsonLength(block.raw_result || {});
        insertLargest({
          tool: name,
          tool_use_id: block.tool_use_id || block.toolCallId || null,
          chars,
          is_error: !!(block.is_error || block.isError),
          preview: oneLine(typeof content === "string" ? content : JSON.stringify(content || ""), 220),
        });
        if (block.is_error || block.isError) errors.push(oneLine(content, 400));
      }
    }
  }

  return {
    event_count: events.length,
    parsed_event_count: events.length,
    truncated: !!payload.truncated,
    byte_length: payload.byte_length || 0,
    returned_byte_length: payload.returned_byte_length || 0,
    offset_bytes: payload.offset_bytes || 0,
    event_types: topCounts(eventTypes),
    inner_event_types: topCounts(innerTypes),
    tool_calls: topCounts(toolCalls),
    tool_results: topCounts(toolResults),
    largest_tool_results: largestToolResults,
    warnings: warnings.slice(-20),
    errors: errors.slice(-20),
    compactions: compactions.slice(-20),
    final_messages: finalMessages.slice(-5).filter(Boolean),
  };
}

function assertInsideDataDir(filePath, dataDir) {
  if (!dataDir) throw runLogError("not_configured", "data directory is required");
  const root = resolve(dataDir);
  const target = resolve(filePath);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw runLogError("forbidden", "raw log path is outside data dir");
}

function normalizeRun(row) {
  return {
    id: row.id,
    task_id: row.task_id || null,
    mode: row.mode,
    stage: row.stage || (row.mode === "review" ? "review" : "execute"),
    agent_name: row.agent_name,
    status: row.status,
    process_status: row.process_status || "running",
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    raw_output_path: row.raw_output_path || null,
  };
}

export function readRunLog({ db, dataDir, runId, mode = "summary", limitBytes = 60_000 }) {
  if (!runId || typeof runId !== "string") {
    throw runLogError("validation", "run_id is required");
  }
  const normalizedMode = normalizeMode(mode);
  const normalizedLimitBytes = normalizeLimitBytes(limitBytes);

  const run = getRunById(db, runId);
  if (!run) throw runLogError("not_found", "run not found");

  if (run.raw_output_path) {
    const rawPath = assertInsideDataDir(run.raw_output_path, dataDir);
    if (existsSync(rawPath)) {
      const payload = normalizedMode === "full"
        ? {
            content: readFileSync(rawPath, "utf8"),
            byte_length: statSync(rawPath).size,
            returned_byte_length: statSync(rawPath).size,
            offset_bytes: 0,
            truncated: false,
          }
        : tailFile(rawPath, normalizedLimitBytes);
      if (normalizedMode === "summary") {
        const events = parseJsonlEvents(payload.content);
        const summary = summarizeEvents(events, payload);
        return {
          run: normalizeRun(run),
          source: "raw_output_path",
          content_type: "application/json",
          mode: normalizedMode,
          summary,
          content: JSON.stringify(summary, null, 2),
        };
      }
      return {
        run: normalizeRun(run),
        source: "raw_output_path",
        content_type: "application/jsonl",
        mode: normalizedMode,
        ...payload,
      };
    }
  }

  const logRow = db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
  if (!logRow) throw runLogError("not_found", "run log not available");
  const events = parseEvents(logRow.events);
  const content = jsonlFromEvents(events);
  const payload = normalizedMode === "full"
    ? {
        content,
        byte_length: Buffer.byteLength(content),
        returned_byte_length: Buffer.byteLength(content),
        offset_bytes: 0,
        truncated: false,
      }
    : tailString(content, normalizedLimitBytes);
  if (normalizedMode === "summary") {
    const summaryEvents = payload.truncated ? parseJsonlEvents(payload.content) : events;
    const summary = summarizeEvents(summaryEvents, payload);
    return {
      run: normalizeRun(run),
      source: "agent_logs.events",
      content_type: "application/json",
      mode: normalizedMode,
      summary,
      content: JSON.stringify(summary, null, 2),
      event_count: events.length,
    };
  }
  return {
    run: normalizeRun(run),
    source: "agent_logs.events",
    content_type: "application/jsonl",
    mode: normalizedMode,
    ...payload,
    event_count: events.length,
  };
}
