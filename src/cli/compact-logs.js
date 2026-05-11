import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../core/db/open.js";
import { runMigrations } from "../core/db/migrations/runner.js";
import { autoPromotedRunResultInfo, kbList, kbRead } from "../core/kb.js";
import { loadConfig } from "../core/config.js";
import { argValue, hasFlag } from "./args.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function numericOption(value, fallback, { min = 0, name } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number >= ${min}`);
  }
  return parsed;
}

function integerOption(value, fallback, { min = 0, name } = {}) {
  const parsed = numericOption(value, fallback, { min, name });
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function activeCoordinatorPid(dataDir) {
  const pidPath = join(dataDir, ".coordinator.pid");
  if (!existsSync(pidPath)) return null;
  let pid = null;
  try {
    pid = Number(String(readFileSync(pidPath, "utf8")).trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    if (err?.code === "ESRCH") return null;
    return pid;
  }
}

function pinnedRunIds(dataDir) {
  const ids = new Set();
  for (const meta of kbList({ dataDir, pinned: true })) {
    if (meta.source_run_id) {
      ids.add(meta.source_run_id);
      continue;
    }
    const entry = kbRead({ dataDir, slug: meta.slug });
    const info = autoPromotedRunResultInfo(entry || meta);
    if (info.source_run_id) ids.add(info.source_run_id);
  }
  return ids;
}

function eventLogRows(db) {
  return db.prepare(`
    SELECT
      l.id,
      l.task_run_id,
      l.events,
      length(l.events) AS bytes,
      l.created_at,
      l.events_compacted_at,
      r.status AS run_status,
      r.process_status AS run_process_status
    FROM agent_logs l
    LEFT JOIN task_runs r ON r.id = l.task_run_id
    ORDER BY bytes DESC
  `).all();
}

function rowAction(row, { now, minAgeDays, minBytes, pinnedRuns }) {
  const bytes = Number(row.bytes || 0);
  if (row.events_compacted_at) return { action: "skip", reason: "already_compacted" };
  if (bytes < minBytes) return { action: "skip", reason: "below_min_bytes" };
  if (now - Number(row.created_at || 0) < minAgeDays * DAY_MS) return { action: "skip", reason: "too_recent" };
  if (row.run_status === "running" || row.run_process_status === "running") return { action: "skip", reason: "running" };
  if (pinnedRuns.has(row.task_run_id)) return { action: "skip", reason: "pinned_kb" };
  const events = parseEvents(row.events);
  if (!events) return { action: "skip", reason: "invalid_events_json" };
  return { action: "compact", events };
}

function compactRow(db, row, events, { keepEvents, now }) {
  const compactedEvents = events.slice(-keepEvents);
  const nextJson = JSON.stringify(compactedEvents);
  db.prepare(`
    UPDATE agent_logs
    SET events = ?,
        events_compacted_at = ?,
        events_original_count = COALESCE(events_original_count, ?),
        events_original_bytes = COALESCE(events_original_bytes, ?)
    WHERE id = ?
  `).run(nextJson, now, events.length, Number(row.bytes || 0), row.id);
  return Buffer.byteLength(nextJson);
}

function compactedEventBytes(events, keepEvents) {
  return Buffer.byteLength(JSON.stringify(events.slice(-keepEvents)));
}

export function compactLogs({
  dataDir = loadConfig().dataDir,
  apply = false,
  minAgeDays = 7,
  minBytes = 512 * 1024,
  keepEvents = 200,
  vacuum = false,
  now = Date.now(),
} = {}) {
  if (apply) {
    const pid = activeCoordinatorPid(dataDir);
    if (pid) throw new Error(`coordinator is running for ${dataDir} (pid ${pid}); stop Worklab before compacting logs`);
  }

  const dbPath = join(dataDir, "worklab.db");
  if (!existsSync(dbPath)) {
    return {
      dry_run: !apply,
      database: dbPath,
      candidates: [],
      compacted_count: 0,
      skipped_count: 0,
      bytes_before: 0,
      bytes_after: 0,
      vacuumed: false,
    };
  }

  const db = openDb(dbPath);
  if (apply) runMigrations(db);
  const pinnedRuns = pinnedRunIds(dataDir);
  const candidates = [];
  let compactedCount = 0;
  let skippedCount = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  try {
    for (const row of eventLogRows(db)) {
      const decision = rowAction(row, { now, minAgeDays, minBytes, pinnedRuns });
      if (decision.action !== "compact") {
        if (!["below_min_bytes", "already_compacted"].includes(decision.reason)) {
          skippedCount += 1;
        }
        continue;
      }
      const before = Number(row.bytes || 0);
      const after = apply
        ? compactRow(db, row, decision.events, { keepEvents, now })
        : compactedEventBytes(decision.events, keepEvents);
      bytesBefore += before;
      bytesAfter += after;
      compactedCount += apply ? 1 : 0;
      candidates.push({
        id: row.id,
        task_run_id: row.task_run_id,
        bytes: before,
        event_count: decision.events.length,
        kept_events: Math.min(keepEvents, decision.events.length),
        action: "compact",
      });
    }
    if (apply && vacuum) db.exec("VACUUM");
  } finally {
    db.close();
  }

  return {
    dry_run: !apply,
    database: dbPath,
    candidates,
    compacted_count: compactedCount,
    skipped_count: skippedCount,
    bytes_before: bytesBefore,
    bytes_after: bytesAfter,
    estimated_reclaimable_bytes: Math.max(0, bytesBefore - bytesAfter),
    vacuumed: Boolean(apply && vacuum),
  };
}

function printReport(report) {
  console.log(report.dry_run ? "compact-logs: DRY RUN" : "compact-logs: APPLIED");
  console.log(`database: ${report.database}`);
  console.log(`candidates: ${report.candidates.filter((row) => row.action === "compact").length}`);
  console.log(`compacted: ${report.compacted_count}`);
  console.log(`skipped: ${report.skipped_count}`);
  console.log(`estimated reclaimable bytes: ${report.estimated_reclaimable_bytes}`);
  for (const row of report.candidates.slice(0, 20)) {
    const suffix = row.action === "skip" ? ` skip:${row.reason}` : ` keep:${row.kept_events}/${row.event_count}`;
    console.log(` - ${row.task_run_id}: ${row.bytes} bytes${suffix}`);
  }
}

export async function compactLogsCli(args = []) {
  const report = compactLogs({
    dataDir: loadConfig().dataDir,
    apply: hasFlag(args, "--apply"),
    minAgeDays: numericOption(argValue(args, "--min-age-days"), 7, { min: 0, name: "--min-age-days" }),
    minBytes: integerOption(argValue(args, "--min-bytes"), 512 * 1024, { min: 0, name: "--min-bytes" }),
    keepEvents: integerOption(argValue(args, "--keep-events"), 200, { min: 1, name: "--keep-events" }),
    vacuum: hasFlag(args, "--vacuum"),
  });
  if (hasFlag(args, "--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report;
}
