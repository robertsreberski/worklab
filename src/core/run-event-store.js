import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { tailRunEventsByVisibleItems } from "./run-events.js";

function runEventStoreError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseRunEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonlRunEvents(value) {
  const out = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // Tail reads and partially-written raw logs can contain fragments.
    }
  }
  return out;
}

export function assertRunLogPathInsideDataDir(rawPath, dataDir) {
  if (!rawPath) throw runEventStoreError("not_found", "raw log not available");
  const target = resolve(rawPath);
  if (!dataDir) return target;
  const root = resolve(dataDir);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw runEventStoreError("forbidden", "raw log path is outside data dir");
}

export function runLogPathInsideDataDir(rawPath, dataDir) {
  try {
    return assertRunLogPathInsideDataDir(rawPath, dataDir);
  } catch (err) {
    if (err?.code === "forbidden" || err?.code === "not_found") return null;
    throw err;
  }
}

export function runEventMode(value) {
  if (value === "tail") return "tail";
  if (value === "none") return "none";
  return "full";
}

export function runEventLimit(value) {
  const parsed = Number(value || 200);
  if (!Number.isInteger(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 500);
}

export function logPayloadFidelity(logRow) {
  if (logRow?.events_compaction_strategy || logRow?.events_compacted_at) return "compacted";
  return "display";
}

export function shapeRunLog(logRow, query = {}, { rawEvents = null } = {}) {
  const mode = runEventMode(query.events);
  if (mode === "full" && Array.isArray(rawEvents)) {
    return {
      ...(logRow || {}),
      events: rawEvents,
      event_count: rawEvents.length,
      events_truncated: false,
      source: "raw_output_path",
      payload_fidelity: "full",
    };
  }
  if (!logRow) return null;
  const payloadFidelity = logPayloadFidelity(logRow);
  if (mode === "none") {
    const eventCount = Number(logRow.event_count || 0);
    return {
      ...logRow,
      events: [],
      event_count: eventCount,
      events_truncated: eventCount > 0,
      source: "agent_logs.events",
      payload_fidelity: payloadFidelity,
    };
  }
  const events = parseRunEvents(logRow.events);
  if (mode !== "tail") {
    const eventCount = Number(logRow.event_count ?? events.length);
    return {
      ...logRow,
      events,
      event_count: eventCount,
      events_truncated: payloadFidelity === "compacted" || eventCount > events.length,
      source: "agent_logs.events",
      payload_fidelity: payloadFidelity,
    };
  }
  const limit = runEventLimit(query.limit);
  const tail = tailRunEventsByVisibleItems(events, limit);
  const eventCount = Number(logRow.event_count ?? events.length);
  return {
    ...logRow,
    events: tail,
    event_count: eventCount,
    events_truncated: eventCount > tail.length || events.length > tail.length,
    source: "agent_logs.events",
    payload_fidelity: payloadFidelity,
  };
}

export function createRunEventStore({ dataDir = null } = {}) {
  function resolveRawPath(row) {
    return runLogPathInsideDataDir(row?.raw_output_path, dataDir);
  }

  function readRawEvents(row) {
    const rawPath = resolveRawPath(row);
    if (!rawPath || !existsSync(rawPath)) return null;
    return parseJsonlRunEvents(readFileSync(rawPath, "utf8"));
  }

  function readRawText(row) {
    const rawPath = assertRunLogPathInsideDataDir(row?.raw_output_path, dataDir);
    if (!existsSync(rawPath)) throw runEventStoreError("not_found", "raw log file not found");
    return readFileSync(rawPath, "utf8");
  }

  return {
    readRawEvents,
    readRawText,
    shapeLog: shapeRunLog,
    eventMode: runEventMode,
    eventLimit: runEventLimit,
  };
}
