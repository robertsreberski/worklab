import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const FILE_CHANGE_SNAPSHOT_LIMIT_BYTES = 300_000;
const FILE_CHANGE_DIFF_LINE_LIMIT = 4000;

function splitFileLines(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function readFileChangeSnapshot(path) {
  try {
    if (!path || !existsSync(path)) return { exists: false, line_count: 0 };
    const stat = statSync(path);
    if (!stat.isFile()) return { exists: false, line_count: 0, unavailable_reason: "not_file" };
    if (stat.size > FILE_CHANGE_SNAPSHOT_LIMIT_BYTES) {
      return { exists: true, size: stat.size, unavailable_reason: "too_large" };
    }
    const content = readFileSync(path, "utf8");
    return {
      exists: true,
      size: stat.size,
      content,
      line_count: splitFileLines(content).length,
    };
  } catch (err) {
    return { exists: false, line_count: 0, unavailable_reason: err?.code || "read_failed" };
  }
}

function lineDiffCounts(beforeContent, afterContent) {
  const beforeLines = splitFileLines(beforeContent);
  const afterLines = splitFileLines(afterContent);
  if (beforeLines.length > FILE_CHANGE_DIFF_LINE_LIMIT || afterLines.length > FILE_CHANGE_DIFF_LINE_LIMIT) {
    return {
      before_lines: beforeLines.length,
      after_lines: afterLines.length,
      unavailable_reason: "too_many_lines",
    };
  }

  let previous = new Array(afterLines.length + 1).fill(0);
  let current = new Array(afterLines.length + 1).fill(0);
  for (let i = 1; i <= beforeLines.length; i += 1) {
    for (let j = 1; j <= afterLines.length; j += 1) {
      current[j] = beforeLines[i - 1] === afterLines[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous.fill(0)];
  }

  const common = previous[afterLines.length];
  const added = afterLines.length - common;
  const removed = beforeLines.length - common;
  return {
    before_lines: beforeLines.length,
    after_lines: afterLines.length,
    added_lines: added,
    removed_lines: removed,
    changed_lines: added + removed,
  };
}

export function statsForCompletedChange(change, before, after) {
  const kind = change?.kind || "change";
  if (before?.unavailable_reason || after?.unavailable_reason) {
    return {
      before_lines: before?.line_count,
      after_lines: after?.line_count,
      unavailable_reason: before?.unavailable_reason || after?.unavailable_reason,
    };
  }
  if (kind === "add" && !before?.exists && after?.exists && typeof after.content === "string") {
    const afterLines = splitFileLines(after.content).length;
    return { before_lines: 0, after_lines: afterLines, added_lines: afterLines, removed_lines: 0, changed_lines: afterLines };
  }
  if (kind === "delete" && before?.exists && !after?.exists && typeof before.content === "string") {
    const beforeLines = splitFileLines(before.content).length;
    return { before_lines: beforeLines, after_lines: 0, added_lines: 0, removed_lines: beforeLines, changed_lines: beforeLines };
  }
  if (typeof before?.content === "string" && typeof after?.content === "string") {
    return lineDiffCounts(before.content, after.content);
  }
  if (before?.exists || after?.exists) {
    return {
      before_lines: before?.line_count,
      after_lines: after?.line_count,
      unavailable_reason: "missing_snapshot",
    };
  }
  return null;
}

export function fileChangeSummary(changes) {
  const stats = changes.map((change) => change?.line_stats).filter(Boolean);
  if (!stats.length) return null;
  return {
    files: changes.length,
    added_lines: stats.reduce((sum, item) => sum + (Number(item.added_lines) || 0), 0),
    removed_lines: stats.reduce((sum, item) => sum + (Number(item.removed_lines) || 0), 0),
    changed_lines: stats.reduce((sum, item) => sum + (Number(item.changed_lines) || 0), 0),
    unavailable_count: stats.filter((item) => item.unavailable_reason).length,
  };
}

function snapshotKey(id, path) {
  return `${id}:${path}`;
}

export function createFileChangePayload(raw, { cwd = process.cwd(), snapshots = new Map() } = {}) {
  const item = raw?.item || {};
  const id = item.id || "file_change";
  const changes = (Array.isArray(item.changes) ? item.changes : []).map((change) => {
    const resolvedPath = change?.path ? resolve(cwd, change.path) : "";
    if (!resolvedPath) return change;
    if (raw.type === "item.started") {
      const before = readFileChangeSnapshot(resolvedPath);
      snapshots.set(snapshotKey(id, resolvedPath), before);
      return change;
    }
    const before = snapshots.get(snapshotKey(id, resolvedPath)) || null;
    const after = readFileChangeSnapshot(resolvedPath);
    snapshots.delete(snapshotKey(id, resolvedPath));
    const lineStats = statsForCompletedChange(change, before, after);
    return lineStats ? { ...change, line_stats: lineStats } : change;
  });
  const summary = fileChangeSummary(changes) || item.summary;
  return {
    changes,
    status: item.status || (raw.type === "item.completed" ? "completed" : "in_progress"),
    ...(summary ? { summary } : {}),
  };
}

export function createFileEditToolUseEvent(id, payload) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "file_edit", input: payload }] },
  };
}

export function createFileEditToolResultEvent(id, payload, { isError = false } = {}) {
  return {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: id,
        content: payload,
        is_error: isError,
      }],
    },
  };
}
