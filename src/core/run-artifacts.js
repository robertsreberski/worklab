import { normalizeCodexItemEvent } from "./codex-events.js";

const DEFAULT_CONTEXT_LIMIT = 25;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function normalizeArtifactPath(path) {
  const value = String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!value) return "";
  return value.replace(/^\.\//, "");
}

function pathParts(path) {
  return normalizeArtifactPath(path).split("/").filter(Boolean);
}

function isAbsolutePath(path) {
  return normalizeArtifactPath(path).startsWith("/");
}

function dirnameParts(path) {
  const parts = pathParts(path);
  return parts.slice(0, Math.max(0, parts.length - 1));
}

function commonPrefix(list) {
  if (!list.length) return [];
  const first = list[0];
  let end = first.length;
  for (const parts of list.slice(1)) {
    end = Math.min(end, parts.length);
    for (let i = 0; i < end; i += 1) {
      if (parts[i] !== first[i]) {
        end = i;
        break;
      }
    }
  }
  return first.slice(0, end);
}

function displayPathMap(paths) {
  const normalized = paths.map(normalizeArtifactPath).filter(Boolean);
  const absolute = normalized.filter(isAbsolutePath);
  const prefix = absolute.length === normalized.length
    ? commonPrefix(absolute.map(dirnameParts))
    : [];
  const map = new Map();
  for (const path of normalized) {
    const parts = pathParts(path);
    const displayParts = prefix.length && isAbsolutePath(path)
      ? parts.slice(prefix.length)
      : parts;
    map.set(path, displayParts.join("/") || parts[parts.length - 1] || path);
  }
  return map;
}

function shortFilePath(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "");
}

function fileEditKindLabel(kind) {
  if (typeof kind === "string" && kind.trim()) return kind.trim();
  if (kind && typeof kind === "object") {
    const type = typeof kind.type === "string" ? kind.type.trim() : "";
    const movePath = typeof kind.move_path === "string" ? kind.move_path.trim() : "";
    if (type && movePath) return `${type} -> ${shortFilePath(movePath)}`;
    if (type) return type;
  }
  return "change";
}

function statusRank(status) {
  if (status === "failed" || status === "error" || status === "errored") return 4;
  if (status === "completed" || status === "succeeded" || status === "complete") return 3;
  if (status === "in_progress" || status === "running") return 2;
  return 1;
}

function mergeStatus(current, next) {
  return statusRank(next) >= statusRank(current) ? next : current;
}

function lineNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFailedStatus(status) {
  return status === "failed" || status === "error" || status === "errored";
}

function isPendingStatus(status) {
  return status === "in_progress" || status === "running";
}

function artifactSeenAt(meta = {}) {
  return Number(meta.ended_at ?? meta.started_at ?? meta.ts ?? 0) || null;
}

function mergeRunMetadata(existing, meta = {}) {
  const runId = meta.run_id || meta.runId || null;
  const seenAt = artifactSeenAt(meta);
  const runIds = new Set(asArray(existing.run_ids));
  if (runId) runIds.add(runId);
  const firstSeenAt = existing.first_seen_at == null || (seenAt != null && seenAt < existing.first_seen_at)
    ? seenAt
    : existing.first_seen_at;
  const lastSeenAt = existing.last_seen_at == null || (seenAt != null && seenAt >= existing.last_seen_at)
    ? seenAt
    : existing.last_seen_at;
  return {
    run_ids: [...runIds],
    first_run_id: existing.first_run_id || runId || null,
    last_run_id: runId || existing.last_run_id || null,
    first_seen_at: firstSeenAt ?? null,
    last_seen_at: lastSeenAt ?? null,
  };
}

function mergeArtifact(map, change, payloadStatus, isError = false, meta = {}) {
  const rawPath = normalizeArtifactPath(change?.path);
  if (!rawPath) return;
  const status = isError ? "failed" : (payloadStatus || "completed");
  const stats = change?.line_stats || {};
  const kind = fileEditKindLabel(change?.kind);
  const existing = map.get(rawPath) || {
    path: rawPath,
    kind,
    status: "in_progress",
    added_lines: 0,
    removed_lines: 0,
    has_line_delta: false,
    before_lines: null,
    after_lines: null,
    unavailable_reason: null,
    run_ids: [],
    first_run_id: null,
    last_run_id: null,
    first_seen_at: null,
    last_seen_at: null,
  };
  const added = lineNumber(stats.added_lines);
  const removed = lineNumber(stats.removed_lines);
  const before = lineNumber(stats.before_lines);
  const after = lineNumber(stats.after_lines);
  map.set(rawPath, {
    ...existing,
    ...mergeRunMetadata(existing, meta),
    kind: kind || existing.kind,
    status: mergeStatus(existing.status, status),
    added_lines: existing.added_lines + (added || 0),
    removed_lines: existing.removed_lines + (removed || 0),
    has_line_delta: existing.has_line_delta || added != null || removed != null,
    before_lines: existing.before_lines == null && before != null ? before : existing.before_lines,
    after_lines: after != null ? after : existing.after_lines,
    unavailable_reason: stats.unavailable_reason || existing.unavailable_reason,
  });
}

function fileEditPayloadFromBlock(block) {
  if (block?.type === "tool_use" && block.name === "file_edit") {
    return { payload: block.input, isError: false };
  }
  if (block?.type === "tool_result") {
    const payload = block.output ?? block.content ?? block.result;
    if (payload && typeof payload === "object" && Array.isArray(payload.changes)) {
      return { payload, isError: Boolean(block.is_error || block.error) };
    }
  }
  return null;
}

function normalizeEvent(event) {
  if (!event) return [];
  if (event.type === "sdk_event") return normalizeEvent(event.event);
  if (event.type === "cli_event" && event.raw) {
    const normalized = normalizeCodexItemEvent(event.raw);
    return normalized ? normalizeEvent(normalized) : [];
  }
  const codexItem = normalizeCodexItemEvent(event);
  if (codexItem) return normalizeEvent(codexItem);
  const content = event.message?.content || event.content;
  if ((event.type === "assistant" || event.type === "message" || event.type === "user") && Array.isArray(content)) {
    return content;
  }
  return [event];
}

function finalizeArtifacts(map) {
  const displayPaths = displayPathMap([...map.keys()]);
  return [...map.values()]
    .map((artifact) => ({
      ...artifact,
      run_ids: asArray(artifact.run_ids),
      display_path: displayPaths.get(artifact.path) || artifact.path,
    }))
    .sort((left, right) => String(left.display_path).localeCompare(String(right.display_path)));
}

export function extractRunArtifacts(events = [], options = {}) {
  const {
    includePending = true,
    includeFailed = true,
    run = null,
  } = options;
  const byPath = new Map();
  const runMeta = run ? {
    run_id: run.id,
    started_at: run.started_at,
    ended_at: run.ended_at,
  } : {};

  for (const event of events || []) {
    const eventMeta = {
      ...runMeta,
      ts: event?.ts,
      event_seq: event?._event_seq,
    };
    for (const block of normalizeEvent(event)) {
      const fileEdit = fileEditPayloadFromBlock(block);
      if (!fileEdit) continue;
      const payload = fileEdit.payload || {};
      const status = payload.status || (block.type === "tool_use" ? "in_progress" : "completed");
      if (!includePending && isPendingStatus(status)) continue;
      if (!includeFailed && (fileEdit.isError || isFailedStatus(status))) continue;
      for (const change of asArray(payload.changes)) {
        mergeArtifact(byPath, change, status, fileEdit.isError, eventMeta);
      }
    }
  }

  return finalizeArtifacts(byPath);
}

export function normalizeStoredArtifacts(value) {
  const parsed = safeJsonParse(value, []);
  if (!Array.isArray(parsed)) return [];
  const byPath = new Map();
  for (const item of parsed) {
    const rawPath = normalizeArtifactPath(item?.path);
    if (!rawPath) continue;
    byPath.set(rawPath, {
      path: rawPath,
      display_path: item.display_path || item.displayPath || rawPath,
      kind: item.kind || "change",
      status: item.status || "completed",
      added_lines: Number(item.added_lines) || 0,
      removed_lines: Number(item.removed_lines) || 0,
      has_line_delta: Boolean(item.has_line_delta),
      before_lines: lineNumber(item.before_lines),
      after_lines: lineNumber(item.after_lines),
      unavailable_reason: item.unavailable_reason || null,
      run_ids: asArray(item.run_ids),
      first_run_id: item.first_run_id || null,
      last_run_id: item.last_run_id || null,
      first_seen_at: lineNumber(item.first_seen_at),
      last_seen_at: lineNumber(item.last_seen_at),
    });
  }
  return finalizeArtifacts(byPath);
}

export function artifactsFromPaths(paths = [], run = null) {
  const byPath = new Map();
  for (const path of asArray(paths)) {
    const rawPath = normalizeArtifactPath(path);
    if (!rawPath) continue;
    const base = {
      path: rawPath,
      kind: "change",
      status: "completed",
      added_lines: 0,
      removed_lines: 0,
      has_line_delta: false,
      before_lines: null,
      after_lines: null,
      unavailable_reason: null,
      run_ids: [],
      first_run_id: null,
      last_run_id: null,
      first_seen_at: null,
      last_seen_at: null,
    };
    byPath.set(rawPath, { ...base, ...mergeRunMetadata(base, run || {}) });
  }
  return finalizeArtifacts(byPath);
}

export function artifactPaths(artifacts = []) {
  return [...new Set(asArray(artifacts).map((item) => normalizeArtifactPath(item?.path)).filter(Boolean))].sort();
}

export function runArtifactSummary(artifacts = []) {
  const runIds = new Set();
  for (const item of artifacts || []) {
    for (const runId of asArray(item.run_ids)) runIds.add(runId);
    if (item.first_run_id) runIds.add(item.first_run_id);
    if (item.last_run_id) runIds.add(item.last_run_id);
  }
  return {
    files: artifacts.length,
    added_lines: artifacts.reduce((sum, item) => sum + (Number(item.added_lines) || 0), 0),
    removed_lines: artifacts.reduce((sum, item) => sum + (Number(item.removed_lines) || 0), 0),
    pending_files: artifacts.filter((item) => isPendingStatus(item.status)).length,
    unavailable_count: artifacts.filter((item) => item.unavailable_reason).length,
    run_count: runIds.size,
  };
}

export function aggregateRunArtifacts(runs = []) {
  const byPath = new Map();
  for (const run of runs || []) {
    const artifacts = normalizeStoredArtifacts(run?.artifacts || run?.artifacts_json || []);
    for (const artifact of artifacts) {
      mergeArtifact(byPath, {
        path: artifact.path,
        kind: artifact.kind,
        line_stats: {
          before_lines: artifact.before_lines,
          after_lines: artifact.after_lines,
          added_lines: artifact.added_lines,
          removed_lines: artifact.removed_lines,
          unavailable_reason: artifact.unavailable_reason,
        },
      }, artifact.status || "completed", isFailedStatus(artifact.status), {
        run_id: artifact.last_run_id || run?.id,
        started_at: artifact.first_seen_at || run?.started_at,
        ended_at: artifact.last_seen_at || run?.ended_at,
      });
      const merged = byPath.get(normalizeArtifactPath(artifact.path));
      if (merged) {
        merged.run_ids = [...new Set([...asArray(merged.run_ids), ...asArray(artifact.run_ids), run?.id].filter(Boolean))];
        merged.first_run_id = merged.first_run_id || artifact.first_run_id || run?.id || null;
        merged.last_run_id = artifact.last_run_id || run?.id || merged.last_run_id || null;
      }
    }
  }
  return finalizeArtifacts(byPath);
}

function parseArtifactPathsJson(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function artifactsForRunRow(row, { events = null } = {}) {
  if (!row) return [];
  const stored = normalizeStoredArtifacts(row.artifacts_json || row.artifacts);
  if (stored.length) return stored;
  if (Array.isArray(events)) {
    const fromEvents = extractRunArtifacts(events, {
      includePending: false,
      includeFailed: false,
      run: row,
    });
    if (fromEvents.length) return fromEvents;
  }
  return artifactsFromPaths(parseArtifactPathsJson(row.artifact_paths_json || row.artifact_paths), {
    run_id: row.id,
    started_at: row.started_at,
    ended_at: row.ended_at,
  });
}

export function loadTaskArtifacts(db, taskId, { excludeRunId = null, fallbackToLogs = true } = {}) {
  if (!db || !taskId) return { artifacts: [], summary: runArtifactSummary([]) };
  const rows = db.prepare(`
    SELECT id, status, process_status, mode, stage, started_at, ended_at,
           artifact_paths_json, artifacts_json, artifact_summary_json
    FROM task_runs
    WHERE task_id = ?
      ${excludeRunId ? "AND id != ?" : ""}
    ORDER BY started_at ASC, rowid ASC
  `).all(...(excludeRunId ? [taskId, excludeRunId] : [taskId]));
  const runs = rows.map((row) => {
    let events = null;
    const processStatus = row.process_status || row.status;
    if (fallbackToLogs && processStatus !== "running" && !normalizeStoredArtifacts(row.artifacts_json).length) {
      const log = db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(row.id);
      events = safeJsonParse(log?.events, []);
    }
    return {
      ...row,
      artifacts: artifactsForRunRow(row, { events }),
    };
  });
  const artifacts = aggregateRunArtifacts(runs);
  return { artifacts, summary: runArtifactSummary(artifacts) };
}

export function artifactDeltaLabel(artifact = {}) {
  const added = Number(artifact.added_lines);
  const removed = Number(artifact.removed_lines);
  if (artifact.has_line_delta && (Number.isFinite(added) || Number.isFinite(removed))) {
    return `+${Number.isFinite(added) ? added : 0} -${Number.isFinite(removed) ? removed : 0}`;
  }
  const before = Number(artifact.before_lines);
  const after = Number(artifact.after_lines);
  if (Number.isFinite(before) && Number.isFinite(after)) return `${before}->${after}`;
  return "";
}

function ensureFolder(parent, name, fullPath) {
  let folder = parent.children.find((node) => node.type === "folder" && node.name === name);
  if (!folder) {
    folder = { name, type: "folder", path: fullPath, children: [] };
    parent.children.push(folder);
  }
  return folder;
}

function sortTree(nodes) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
  return nodes;
}

export function buildRunArtifactTree(artifacts = []) {
  const root = { children: [] };
  for (const artifact of artifacts) {
    const parts = pathParts(artifact.display_path || artifact.path);
    if (!parts.length) continue;
    let parent = root;
    let fullPath = "";
    for (const part of parts.slice(0, -1)) {
      fullPath = fullPath ? `${fullPath}/${part}` : part;
      parent = ensureFolder(parent, part, fullPath);
    }
    parent.children.push({
      ...artifact,
      name: parts[parts.length - 1],
      type: "file",
      path: artifact.path,
    });
  }
  return sortTree(root.children);
}

export function formatTaskArtifactsForPrompt(taskArtifacts, { limit = DEFAULT_CONTEXT_LIMIT } = {}) {
  const artifacts = normalizeStoredArtifacts(taskArtifacts?.artifacts || taskArtifacts || []);
  if (!artifacts.length) return "";
  const summary = taskArtifacts?.summary || runArtifactSummary(artifacts);
  const lineLabel = summary.added_lines || summary.removed_lines
    ? `, +${summary.added_lines || 0} -${summary.removed_lines || 0}`
    : "";
  const runLabel = summary.run_count
    ? ` across ${summary.run_count} run${summary.run_count === 1 ? "" : "s"}`
    : "";
  const sorted = [...artifacts].sort((a, b) => (Number(b.last_seen_at) || 0) - (Number(a.last_seen_at) || 0));
  const shown = sorted.slice(0, limit);
  const lines = [
    `Task-wide file changes before this run: ${summary.files} file${summary.files === 1 ? "" : "s"}${lineLabel}${runLabel}.`,
    "",
    ...shown.map((artifact) => {
      const delta = artifactDeltaLabel(artifact);
      const details = [
        delta,
        artifact.last_run_id ? `last run \`${artifact.last_run_id}\`` : "",
        artifact.unavailable_reason || "",
      ].filter(Boolean);
      return `- \`${artifact.display_path || artifact.path}\`${details.length ? ` (${details.join(", ")})` : ""}`;
    }),
  ];
  const omitted = sorted.length - shown.length;
  if (omitted > 0) lines.push(`- ... ${omitted} more file${omitted === 1 ? "" : "s"} omitted from prompt context.`);
  return lines.join("\n");
}
