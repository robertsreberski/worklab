import { normalizeCodexItemEvent } from "../../../core/codex-events.js";
import { fileEditKindLabel } from "./fileEditDisplay.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePath(path) {
  const value = String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!value) return "";
  return value.replace(/^\.\//, "");
}

function pathParts(path) {
  return normalizePath(path).split("/").filter(Boolean);
}

function isAbsolutePath(path) {
  return normalizePath(path).startsWith("/");
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
  const normalized = paths.map(normalizePath).filter(Boolean);
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

function statusRank(status) {
  if (status === "failed" || status === "error" || status === "errored") return 4;
  if (status === "completed" || status === "succeeded") return 3;
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

function mergeArtifact(map, change, payloadStatus, isError = false) {
  const rawPath = normalizePath(change?.path);
  if (!rawPath) return;
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
  };
  const added = lineNumber(stats.added_lines);
  const removed = lineNumber(stats.removed_lines);
  const before = lineNumber(stats.before_lines);
  const after = lineNumber(stats.after_lines);
  map.set(rawPath, {
    ...existing,
    kind: kind || existing.kind,
    status: mergeStatus(existing.status, isError ? "failed" : (payloadStatus || existing.status)),
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

export function extractRunArtifacts(events = []) {
  const byPath = new Map();
  for (const event of events || []) {
    for (const block of normalizeEvent(event)) {
      const fileEdit = fileEditPayloadFromBlock(block);
      if (!fileEdit) continue;
      const payload = fileEdit.payload || {};
      const status = payload.status || (block.type === "tool_use" ? "in_progress" : "completed");
      for (const change of asArray(payload.changes)) {
        mergeArtifact(byPath, change, status, fileEdit.isError);
      }
    }
  }
  const displayPaths = displayPathMap([...byPath.keys()]);
  return [...byPath.values()]
    .map((artifact) => ({
      ...artifact,
      display_path: displayPaths.get(artifact.path) || artifact.path,
    }))
    .sort((left, right) => left.display_path.localeCompare(right.display_path));
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

export function runArtifactSummary(artifacts = []) {
  return {
    files: artifacts.length,
    added_lines: artifacts.reduce((sum, item) => sum + (Number(item.added_lines) || 0), 0),
    removed_lines: artifacts.reduce((sum, item) => sum + (Number(item.removed_lines) || 0), 0),
    pending_files: artifacts.filter((item) => item.status === "in_progress" || item.status === "running").length,
    unavailable_count: artifacts.filter((item) => item.unavailable_reason).length,
  };
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
