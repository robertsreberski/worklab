import { existsSync, readFileSync } from "node:fs";
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

export function readRunLog({ db, dataDir, runId }) {
  if (!runId || typeof runId !== "string") {
    throw runLogError("validation", "run_id is required");
  }

  const run = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
  if (!run) throw runLogError("not_found", "run not found");

  if (run.raw_output_path) {
    const rawPath = assertInsideDataDir(run.raw_output_path, dataDir);
    if (existsSync(rawPath)) {
      const content = readFileSync(rawPath, "utf8");
      return {
        run: normalizeRun(run),
        source: "raw_output_path",
        content_type: "application/jsonl",
        content,
        byte_length: Buffer.byteLength(content),
      };
    }
  }

  const logRow = db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
  if (!logRow) throw runLogError("not_found", "run log not available");
  const events = parseEvents(logRow.events);
  const content = jsonlFromEvents(events);
  return {
    run: normalizeRun(run),
    source: "agent_logs.events",
    content_type: "application/jsonl",
    content,
    event_count: events.length,
    byte_length: Buffer.byteLength(content),
  };
}
