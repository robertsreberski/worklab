import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  autoPromotedRunResultInfo,
  DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS,
  kbList,
  kbRead,
  loadConfig,
  openDb,
  runMigrations,
  SQLITE_LOG_COMPACTION_STRATEGY,
  SQLITE_LOG_COMPACTION_VERSION,
  compactEventsForSqlite,
  jsonByteLength,
} from "../core/index.js";
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

function strategyOption(value) {
  const strategy = value || SQLITE_LOG_COMPACTION_STRATEGY;
  if (strategy === SQLITE_LOG_COMPACTION_STRATEGY || strategy === "tail") return strategy;
  throw new Error(`--strategy must be "${SQLITE_LOG_COMPACTION_STRATEGY}" or "tail"`);
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
      r.process_status AS run_process_status,
      r.raw_output_path
    FROM agent_logs l
    LEFT JOIN task_runs r ON r.id = l.task_run_id
    ORDER BY bytes DESC
  `).all();
}

function rowAction(row, { now, minAgeDays, minBytes, pinnedRuns, recompact }) {
  const bytes = Number(row.bytes || 0);
  if (row.events_compacted_at && !recompact) return { action: "skip", reason: "already_compacted" };
  if (bytes < minBytes) return { action: "skip", reason: "below_min_bytes" };
  if (now - Number(row.created_at || 0) < minAgeDays * DAY_MS) return { action: "skip", reason: "too_recent" };
  if (row.run_status === "running" || row.run_process_status === "running") return { action: "skip", reason: "running" };
  if (pinnedRuns.has(row.task_run_id)) return { action: "skip", reason: "pinned_kb" };
  const events = parseEvents(row.events);
  if (!events) return { action: "skip", reason: "invalid_events_json" };
  return { action: "compact", events };
}

function compactEvents(events, { strategy, keepEvents, maxEventBytes, maxLogBytes }) {
  if (strategy === "tail") {
    const compactedEvents = events.slice(-keepEvents);
    return {
      events: compactedEvents,
      bytes: jsonByteLength(compactedEvents),
      original_count: events.length,
      original_bytes: jsonByteLength(events),
      kept_events: Math.min(keepEvents, events.length),
      omitted_events: Math.max(0, events.length - keepEvents),
      strategy,
      version: 1,
    };
  }
  return compactEventsForSqlite(events, { keepEvents, maxEventBytes, maxLogBytes });
}

function compactRow(db, row, events, options) {
  const compacted = compactEvents(events, options);
  const nextJson = JSON.stringify(compacted.events);
  db.prepare(`
    UPDATE agent_logs
    SET events = ?,
        events_compacted_at = ?,
        events_original_count = COALESCE(events_original_count, ?),
        events_original_bytes = COALESCE(events_original_bytes, ?),
        events_compaction_strategy = ?,
        events_compaction_version = ?,
        events_compacted_bytes = ?
    WHERE id = ?
  `).run(
    nextJson,
    options.now,
    events.length,
    Number(row.bytes || 0),
    compacted.strategy,
    compacted.version,
    compacted.bytes,
    row.id,
  );
  return compacted;
}

function compactedEvents(events, options) {
  return compactEvents(events, options);
}

function databaseSize(dbPath) {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function eventBlobStats(db) {
  return db.prepare(`
    SELECT
      COUNT(*) AS logs,
      COALESCE(SUM(length(l.events)), 0) AS bytes,
      COALESCE(SUM(CASE WHEN l.events_compacted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS compacted_logs,
      COALESCE(SUM(CASE WHEN l.events_compacted_at IS NOT NULL THEN length(l.events) ELSE 0 END), 0) AS compacted_bytes,
      COALESCE(SUM(CASE WHEN l.events_compacted_at IS NULL THEN length(l.events) ELSE 0 END), 0) AS uncompacted_bytes,
      COALESCE(SUM(CASE WHEN r.raw_output_path IS NOT NULL AND r.raw_output_path != '' THEN length(l.events) ELSE 0 END), 0) AS bytes_with_raw_file,
      COALESCE(SUM(CASE WHEN r.raw_output_path IS NULL OR r.raw_output_path = '' THEN length(l.events) ELSE 0 END), 0) AS bytes_without_raw_file
    FROM agent_logs l
    LEFT JOIN task_runs r ON r.id = l.task_run_id
  `).get();
}

export function compactLogs({
  dataDir = loadConfig().dataDir,
  apply = false,
  minAgeDays = 7,
  minBytes = 512 * 1024,
  keepEvents = 200,
  strategy = SQLITE_LOG_COMPACTION_STRATEGY,
  recompact = false,
  maxEventBytes = DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxEventBytes,
  maxLogBytes = DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxLogBytes,
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
      event_blob_bytes_before: 0,
      event_blob_bytes_after: 0,
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
  const beforeStats = eventBlobStats(db);

  try {
    for (const row of eventLogRows(db)) {
      const decision = rowAction(row, { now, minAgeDays, minBytes, pinnedRuns, recompact });
      if (decision.action !== "compact") {
        if (!["below_min_bytes", "already_compacted"].includes(decision.reason)) {
          skippedCount += 1;
        }
        continue;
      }
      const before = Number(row.bytes || 0);
      const compacted = apply
        ? compactRow(db, row, decision.events, { strategy, keepEvents, maxEventBytes, maxLogBytes, now })
        : compactedEvents(decision.events, { strategy, keepEvents, maxEventBytes, maxLogBytes, now });
      bytesBefore += before;
      bytesAfter += compacted.bytes;
      compactedCount += apply ? 1 : 0;
      candidates.push({
        id: row.id,
        task_run_id: row.task_run_id,
        bytes: before,
        bytes_before: before,
        bytes_after: compacted.bytes,
        estimated_reclaimable_bytes: Math.max(0, before - compacted.bytes),
        event_count: decision.events.length,
        kept_events: compacted.kept_events,
        omitted_events: compacted.omitted_events,
        already_compacted: !!row.events_compacted_at,
        has_raw_log: !!row.raw_output_path,
        strategy: compacted.strategy,
        compaction_version: compacted.version,
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
    database_size_bytes: databaseSize(dbPath),
    strategy,
    compaction_version: strategy === SQLITE_LOG_COMPACTION_STRATEGY ? SQLITE_LOG_COMPACTION_VERSION : 1,
    recompact,
    max_event_bytes: maxEventBytes,
    max_log_bytes: maxLogBytes,
    candidates,
    compacted_count: compactedCount,
    skipped_count: skippedCount,
    bytes_before: bytesBefore,
    bytes_after: bytesAfter,
    estimated_reclaimable_bytes: Math.max(0, bytesBefore - bytesAfter),
    event_blob_bytes_before: Number(beforeStats.bytes || 0),
    event_blob_bytes_after: Math.max(0, Number(beforeStats.bytes || 0) - bytesBefore + bytesAfter),
    bytes_with_raw_file: Number(beforeStats.bytes_with_raw_file || 0),
    bytes_without_raw_file: Number(beforeStats.bytes_without_raw_file || 0),
    compacted_logs: Number(beforeStats.compacted_logs || 0),
    uncompacted_bytes: Number(beforeStats.uncompacted_bytes || 0),
    vacuumed: Boolean(apply && vacuum),
  };
}

function printReport(report) {
  console.log(report.dry_run ? "compact-logs: DRY RUN" : "compact-logs: APPLIED");
  console.log(`database: ${report.database}`);
  console.log(`database size bytes: ${report.database_size_bytes}`);
  console.log(`strategy: ${report.strategy}${report.recompact ? " (recompact)" : ""}`);
  console.log(`candidates: ${report.candidates.filter((row) => row.action === "compact").length}`);
  console.log(`compacted: ${report.compacted_count}`);
  console.log(`skipped: ${report.skipped_count}`);
  console.log(`event blob bytes before: ${report.event_blob_bytes_before}`);
  console.log(`event blob bytes after: ${report.event_blob_bytes_after}`);
  console.log(`bytes with raw log file: ${report.bytes_with_raw_file}`);
  console.log(`bytes without raw log file: ${report.bytes_without_raw_file}`);
  console.log(`estimated reclaimable bytes: ${report.estimated_reclaimable_bytes}`);
  for (const row of report.candidates.slice(0, 20)) {
    const suffix = row.action === "skip" ? ` skip:${row.reason}` : ` keep:${row.kept_events}/${row.event_count} after:${row.bytes_after}`;
    console.log(` - ${row.task_run_id}: ${row.bytes_before || row.bytes} bytes${suffix}`);
  }
}

export async function compactLogsCli(args = []) {
  const report = compactLogs({
    dataDir: loadConfig().dataDir,
    apply: hasFlag(args, "--apply"),
    minAgeDays: numericOption(argValue(args, "--min-age-days"), 7, { min: 0, name: "--min-age-days" }),
    minBytes: integerOption(argValue(args, "--min-bytes"), 512 * 1024, { min: 0, name: "--min-bytes" }),
    keepEvents: integerOption(argValue(args, "--keep-events"), 200, { min: 1, name: "--keep-events" }),
    strategy: strategyOption(argValue(args, "--strategy")),
    recompact: hasFlag(args, "--recompact"),
    maxEventBytes: integerOption(argValue(args, "--max-event-bytes"), DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxEventBytes, { min: 0, name: "--max-event-bytes" }),
    maxLogBytes: integerOption(argValue(args, "--max-log-bytes"), DEFAULT_SQLITE_LOG_COMPACTION_OPTIONS.maxLogBytes, { min: 0, name: "--max-log-bytes" }),
    vacuum: hasFlag(args, "--vacuum"),
  });
  if (hasFlag(args, "--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report;
}
