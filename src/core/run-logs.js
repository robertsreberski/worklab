import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { legacyRunStatusToProcessStatus } from "./state-machine.js";

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
  return value === "full" ? "full" : "tail";
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
    process_status: row.status !== "running" && row.process_status === "running"
      ? legacyRunStatusToProcessStatus(row.status)
      : (row.process_status || legacyRunStatusToProcessStatus(row.status)),
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    raw_output_path: row.raw_output_path || null,
  };
}

export function readRunLog({ db, dataDir, runId, mode = "tail", limitBytes = 60_000 }) {
  if (!runId || typeof runId !== "string") {
    throw runLogError("validation", "run_id is required");
  }
  const normalizedMode = normalizeMode(mode);
  const normalizedLimitBytes = normalizeLimitBytes(limitBytes);

  const run = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
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
  return {
    run: normalizeRun(run),
    source: "agent_logs.events",
    content_type: "application/jsonl",
    mode: normalizedMode,
    ...payload,
    event_count: events.length,
  };
}
