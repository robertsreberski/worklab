import { normalizeCodexItemEvent } from "../ai/streaming/codex-events.js";
import { getAgentLogEvents } from "./db/queries/agent-logs.js";

const DEFAULT_CONTEXT_LIMIT = 25;
const STORED_HUNK_LIMIT = 32;
const CODE_PATH_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);
const CODE_PATH_BASENAMES = new Set([
  "Dockerfile",
  "Makefile",
  "README",
  "README.md",
  "package.json",
  "tsconfig.json",
  "vite.config.js",
  "vitest.config.js",
]);
const ARTIFACT_TYPE_RANK = {
  generated_output: 1,
  scratch: 2,
  qa_output: 3,
  git_commit: 4,
  code_change: 5,
};

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

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function basename(path) {
  return String(path || "").split("/").filter(Boolean).pop() || "";
}

function extension(path) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function artifactTypeForPath(path, { source = "file_edit" } = {}) {
  const normalized = normalizeArtifactPath(path);
  if (source === "qa_output_dir") return "qa_output";
  if (source === "git") return "git_commit";
  if (normalized.includes("/.worklab-tmp/") || normalized.startsWith(".worklab-tmp/")) return "scratch";
  const name = basename(normalized);
  if (CODE_PATH_BASENAMES.has(name) || CODE_PATH_EXTENSIONS.has(extension(normalized))) return "code_change";
  return "generated_output";
}

function mergeArtifactType(current, next) {
  const currentType = current || "generated_output";
  const nextType = next || "generated_output";
  return (ARTIFACT_TYPE_RANK[nextType] || 0) >= (ARTIFACT_TYPE_RANK[currentType] || 0)
    ? nextType
    : currentType;
}

function mergeSources(existing, incoming) {
  return [...new Set([
    ...asArray(existing.sources),
    existing.source,
    incoming,
  ].filter(Boolean))];
}

function mergeEventSeq(existing, incoming) {
  const current = numberOrNull(existing);
  const next = numberOrNull(incoming);
  if (current == null) return next;
  if (next == null) return current;
  return Math.min(current, next);
}

function mergeLastEventSeq(existing, incoming) {
  const current = numberOrNull(existing);
  const next = numberOrNull(incoming);
  if (current == null) return next;
  if (next == null) return current;
  return Math.max(current, next);
}

function normalizeHunks(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const start = lineNumber(item?.start);
    const end = lineNumber(item?.end);
    if (start == null || end == null) continue;
    if (start < 1 || end < start) continue;
    result.push({ start, end });
  }
  return result;
}

function mergeHunkRanges(existing, incoming) {
  const all = [...normalizeHunks(existing), ...normalizeHunks(incoming)]
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged.slice(0, STORED_HUNK_LIMIT);
}

function clampHunks(hunks) {
  const normalized = normalizeHunks(hunks);
  return normalized.length <= STORED_HUNK_LIMIT ? normalized : normalized.slice(0, STORED_HUNK_LIMIT);
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
  const incomingSource = change?.source || meta.source || "file_edit";
  const incomingType = change?.artifact_type || meta.artifact_type || artifactTypeForPath(rawPath, { source: incomingSource });
  const incomingTemporary = change?.temporary ?? meta.temporary ?? (incomingType === "scratch");
  const incomingEventSeq = numberOrNull(change?.event_seq ?? meta.event_seq);
  const incomingFirstEventSeq = numberOrNull(change?.first_event_seq ?? meta.first_event_seq ?? incomingEventSeq);
  const incomingLastEventSeq = numberOrNull(change?.last_event_seq ?? meta.last_event_seq ?? incomingEventSeq);
  const incomingEventCount = numberOrNull(change?.event_count ?? meta.event_count)
    ?? (incomingEventSeq == null ? 0 : 1);
  const existing = map.get(rawPath) || {
    path: rawPath,
    kind,
    status: "in_progress",
    artifact_type: incomingType,
    source: incomingSource,
    sources: incomingSource ? [incomingSource] : [],
    temporary: Boolean(incomingTemporary),
    size_bytes: numberOrNull(change?.size_bytes ?? meta.size_bytes),
    href: change?.href || meta.href || null,
    artifact_relative_path: change?.artifact_relative_path || meta.artifact_relative_path || null,
    event_count: 0,
    first_event_seq: null,
    last_event_seq: null,
    added_lines: 0,
    removed_lines: 0,
    has_line_delta: false,
    before_lines: null,
    after_lines: null,
    unavailable_reason: null,
    hunks: [],
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
  const incomingHunks = Array.isArray(stats.hunks) && stats.hunks.length > 0 ? stats.hunks : null;
  const incomingRunId = meta.run_id || meta.runId || null;
  let nextHunks = normalizeHunks(existing.hunks);
  if (incomingHunks) {
    const sameRun = !existing.last_run_id || !incomingRunId || existing.last_run_id === incomingRunId;
    nextHunks = sameRun
      ? mergeHunkRanges(existing.hunks, incomingHunks)
      : clampHunks(incomingHunks);
  }
  map.set(rawPath, {
    ...existing,
    ...mergeRunMetadata(existing, meta),
    kind: kind || existing.kind,
    status: mergeStatus(existing.status, status),
    artifact_type: mergeArtifactType(existing.artifact_type, incomingType),
    source: existing.source === incomingSource ? existing.source : "multiple",
    sources: mergeSources(existing, incomingSource),
    temporary: Boolean(existing.temporary || incomingTemporary),
    size_bytes: numberOrNull(change?.size_bytes ?? meta.size_bytes) ?? existing.size_bytes ?? null,
    href: change?.href || meta.href || existing.href || null,
    artifact_relative_path: change?.artifact_relative_path || meta.artifact_relative_path || existing.artifact_relative_path || null,
    event_count: (Number(existing.event_count) || 0) + incomingEventCount,
    first_event_seq: mergeEventSeq(existing.first_event_seq, incomingFirstEventSeq),
    last_event_seq: mergeLastEventSeq(existing.last_event_seq, incomingLastEventSeq),
    added_lines: existing.added_lines + (added || 0),
    removed_lines: existing.removed_lines + (removed || 0),
    has_line_delta: existing.has_line_delta || added != null || removed != null,
    before_lines: existing.before_lines == null && before != null ? before : existing.before_lines,
    after_lines: after != null ? after : existing.after_lines,
    unavailable_reason: stats.unavailable_reason || existing.unavailable_reason,
    hunks: nextHunks,
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
      artifact_type: item.artifact_type || artifactTypeForPath(rawPath, { source: item.source || "stored" }),
      source: item.source || "stored",
      sources: asArray(item.sources),
      temporary: Boolean(item.temporary),
      size_bytes: numberOrNull(item.size_bytes),
      href: item.href || null,
      artifact_relative_path: item.artifact_relative_path || null,
      event_count: Number(item.event_count) || 0,
      first_event_seq: numberOrNull(item.first_event_seq),
      last_event_seq: numberOrNull(item.last_event_seq),
      added_lines: Number(item.added_lines) || 0,
      removed_lines: Number(item.removed_lines) || 0,
      has_line_delta: Boolean(item.has_line_delta),
      before_lines: lineNumber(item.before_lines),
      after_lines: lineNumber(item.after_lines),
      unavailable_reason: item.unavailable_reason || null,
      hunks: clampHunks(item.hunks),
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
      artifact_type: artifactTypeForPath(rawPath, { source: "legacy_path" }),
      source: "legacy_path",
      sources: ["legacy_path"],
      temporary: false,
      size_bytes: null,
      href: null,
      artifact_relative_path: null,
      event_count: 0,
      first_event_seq: null,
      last_event_seq: null,
      added_lines: 0,
      removed_lines: 0,
      has_line_delta: false,
      before_lines: null,
      after_lines: null,
      unavailable_reason: null,
      hunks: [],
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
          hunks: artifact.hunks,
        },
        artifact_type: artifact.artifact_type,
        source: artifact.source,
        sources: artifact.sources,
        temporary: artifact.temporary,
        size_bytes: artifact.size_bytes,
        href: artifact.href,
        artifact_relative_path: artifact.artifact_relative_path,
        event_count: artifact.event_count,
        first_event_seq: artifact.first_event_seq,
        last_event_seq: artifact.last_event_seq,
      }, artifact.status || "completed", isFailedStatus(artifact.status), {
        run_id: artifact.last_run_id || run?.id,
        started_at: artifact.first_seen_at || run?.started_at,
        ended_at: artifact.last_seen_at || run?.ended_at,
        event_count: artifact.event_count,
        first_event_seq: artifact.first_event_seq,
        last_event_seq: artifact.last_event_seq,
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
      const log = getAgentLogEvents(db, row.id);
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

function compactRangesForDisplay(hunks, { collapseGap = 2 } = {}) {
  const sorted = normalizeHunks(hunks).sort((a, b) => a.start - b.start);
  const collapsed = [];
  for (const range of sorted) {
    const last = collapsed[collapsed.length - 1];
    if (last && range.start <= last.end + 1 + collapseGap) {
      last.end = Math.max(last.end, range.end);
    } else {
      collapsed.push({ start: range.start, end: range.end });
    }
  }
  return collapsed;
}

export function formatHunkRanges(hunks, { max = 6 } = {}) {
  const collapsed = compactRangesForDisplay(hunks);
  if (!collapsed.length) return "";
  const shown = collapsed.slice(0, max);
  const omitted = collapsed.length - shown.length;
  if (shown.length === 1) {
    const only = shown[0];
    return only.start === only.end ? `line ${only.start}` : `lines ${only.start}-${only.end}`;
  }
  const labels = shown.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`));
  const tail = omitted > 0 ? `, +${omitted} more` : "";
  return `lines ${labels.join(", ")}${tail}`;
}

function artifactKindLabel(artifact = {}) {
  const kind = String(artifact.kind || "").trim().toLowerCase();
  if (kind === "add") return "new file";
  if (kind === "delete") return "deleted";
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

const ARTIFACT_GROUPS = [
  ["code_change", "Code changes"],
  ["qa_output", "QA evidence"],
  ["generated_output", "Generated outputs"],
  ["git_commit", "Git provenance"],
  ["scratch", "Scratch and diagnostics"],
];

export function groupRunArtifacts(artifacts = []) {
  const normalized = normalizeStoredArtifacts(artifacts);
  const byGroup = new Map(ARTIFACT_GROUPS.map(([id, label]) => [id, { id, label, artifacts: [] }]));
  const fallback = byGroup.get("generated_output");
  for (const artifact of normalized) {
    const group = byGroup.get(artifact.artifact_type) || fallback;
    group.artifacts.push(artifact);
  }
  return [...byGroup.values()]
    .filter((group) => group.artifacts.length > 0)
    .map((group) => ({
      ...group,
      tree: buildRunArtifactTree(group.artifacts),
      summary: runArtifactSummary(group.artifacts),
    }));
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
      const kindLabel = artifactKindLabel(artifact);
      const ranges = kindLabel ? "" : formatHunkRanges(artifact.hunks);
      const details = [
        delta,
        kindLabel,
        ranges,
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
