import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { worklabBaseUrl } from "../core/index.js";
import { hasFlag } from "./args.js";

const DEFAULT_ENDPOINTS = [
  "/",
  "/api/health",
  "/api/tasks?scope=runtime&done_limit=0",
  "/api/agents?view=summary",
  "/api/activity?limit=50",
  "/api/kb",
  "/api/search/status",
];

const DEFAULT_BUDGETS = {
  endpointMsWarn: 250,
  endpointBytesWarn: 250_000,
  dbBytesWarn: 1_024 * 1_024 * 1_024,
  agentLogsBytesWarn: 256 * 1_024 * 1_024,
  eventBlobBytesWarn: 5 * 1_024 * 1_024,
};

function bytesLabel(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1_024 * 1_024) return `${(value / 1_024 / 1_024).toFixed(1)} MiB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${value} B`;
}

function dbObjectSizes(db) {
  try {
    return db.prepare(`
      SELECT name, SUM(pgsize) AS bytes
      FROM dbstat
      GROUP BY name
      ORDER BY bytes DESC
      LIMIT 20
    `).all().map((row) => ({ name: row.name, bytes: Number(row.bytes || 0) }));
  } catch {
    try {
      const agentLogs = db.prepare("SELECT COALESCE(SUM(length(events)), 0) AS bytes FROM agent_logs").get();
      return [{ name: "agent_logs", bytes: Number(agentLogs?.bytes || 0), approximate: true }];
    } catch {
      return [];
    }
  }
}

function largestAgentLogs(db) {
  try {
    return db.prepare(`
      SELECT
        task_run_id,
        length(events) AS bytes,
        json_array_length(events) AS event_count,
        created_at
      FROM agent_logs
      ORDER BY bytes DESC
      LIMIT 10
    `).all().map((row) => ({
      task_run_id: row.task_run_id,
      bytes: Number(row.bytes || 0),
      event_count: Number(row.event_count || 0),
      created_at: row.created_at ?? null,
    }));
  } catch {
    return [];
  }
}

function databaseReport(config) {
  const dbPath = join(config.dataDir, "worklab.db");
  const report = {
    path: dbPath,
    exists: existsSync(dbPath),
    file_bytes: 0,
    largest_objects: [],
    largest_agent_logs: [],
  };
  if (!report.exists) return report;
  report.file_bytes = statSync(dbPath).size;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    report.largest_objects = dbObjectSizes(db);
    report.largest_agent_logs = largestAgentLogs(db);
  } catch (err) {
    report.error = err.message;
  } finally {
    db?.close?.();
  }
  return report;
}

async function endpointReport(config, { fetchImpl = fetch, endpointPaths = DEFAULT_ENDPOINTS } = {}) {
  const baseUrl = worklabBaseUrl(config);
  const out = [];
  for (const path of endpointPaths) {
    const start = process.hrtime.bigint();
    try {
      const res = await fetchImpl(`${baseUrl}${path}`);
      const text = await res.text();
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      out.push({
        path,
        status: res.status,
        duration_ms: Math.round(durationMs),
        response_bytes: Buffer.byteLength(text),
      });
    } catch (err) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      out.push({
        path,
        status: null,
        duration_ms: Math.round(durationMs),
        response_bytes: 0,
        error: err.message,
      });
    }
  }
  return out;
}

function warningList(report, budgets) {
  const warnings = [];
  if (report.database.file_bytes >= budgets.dbBytesWarn) {
    warnings.push(`database file is ${bytesLabel(report.database.file_bytes)}`);
  }
  const agentLogs = report.database.largest_objects.find((row) => row.name === "agent_logs");
  if (agentLogs?.bytes >= budgets.agentLogsBytesWarn) {
    warnings.push(`agent_logs is ${bytesLabel(agentLogs.bytes)}`);
  }
  const largestLog = report.database.largest_agent_logs[0];
  if (largestLog?.bytes >= budgets.eventBlobBytesWarn) {
    warnings.push(`largest event log ${largestLog.task_run_id} is ${bytesLabel(largestLog.bytes)}`);
  }
  for (const endpoint of report.endpoints) {
    if (endpoint.error) {
      warnings.push(`${endpoint.path} could not be timed: ${endpoint.error}`);
      continue;
    }
    if (endpoint.duration_ms >= budgets.endpointMsWarn) {
      warnings.push(`${endpoint.path} took ${endpoint.duration_ms} ms`);
    }
    if (endpoint.response_bytes >= budgets.endpointBytesWarn) {
      warnings.push(`${endpoint.path} payload is ${bytesLabel(endpoint.response_bytes)}`);
    }
  }
  return warnings;
}

export async function collectPerformanceReport({
  config = loadConfig(),
  fetchImpl = fetch,
  endpointPaths = DEFAULT_ENDPOINTS,
  budgets = DEFAULT_BUDGETS,
} = {}) {
  const mergedBudgets = { ...DEFAULT_BUDGETS, ...(budgets || {}) };
  const report = {
    generated_at: new Date().toISOString(),
    budgets: mergedBudgets,
    database: databaseReport(config),
    endpoints: await endpointReport(config, { fetchImpl, endpointPaths }),
    warnings: [],
  };
  report.warnings = warningList(report, mergedBudgets);
  return report;
}

function printTextReport(report) {
  console.log(report.warnings.length ? "performance: ISSUES" : "performance: OK");
  console.log(`db: ${report.database.exists ? bytesLabel(report.database.file_bytes) : "missing"} (${report.database.path})`);
  if (report.database.largest_objects.length) {
    console.log("largest db objects:");
    for (const row of report.database.largest_objects.slice(0, 8)) {
      console.log(` - ${row.name}: ${bytesLabel(row.bytes)}${row.approximate ? " approximate" : ""}`);
    }
  }
  if (report.database.largest_agent_logs.length) {
    console.log("largest event logs:");
    for (const row of report.database.largest_agent_logs.slice(0, 5)) {
      console.log(` - ${row.task_run_id}: ${bytesLabel(row.bytes)} (${row.event_count} events)`);
    }
  }
  if (report.endpoints.length) {
    console.log("endpoint timings:");
    for (const endpoint of report.endpoints) {
      const status = endpoint.status ?? "ERR";
      const suffix = endpoint.error ? ` ${endpoint.error}` : ` ${bytesLabel(endpoint.response_bytes)}`;
      console.log(` - ${endpoint.path}: ${status} ${endpoint.duration_ms} ms${suffix}`);
    }
  }
  if (report.warnings.length) {
    console.log("warnings:");
    for (const warning of report.warnings) console.log(` - ${warning}`);
  }
}

export async function doctorPerformance(args = []) {
  const report = await collectPerformanceReport({ config: loadConfig() });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  printTextReport(report);
  return report;
}
