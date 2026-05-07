import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const FILE_CHANGE_SNAPSHOT_LIMIT_BYTES = 300_000;
const FILE_CHANGE_DIFF_LINE_LIMIT = 4000;
const FILE_CHANGE_HUNK_LINE_LIMIT = 2000;

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

function rollingLcsCount(beforeLines, afterLines) {
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
  return previous[afterLines.length];
}

function fullLcsTableWithHunks(beforeLines, afterLines) {
  const m = beforeLines.length;
  const n = afterLines.length;
  const stride = n + 1;
  const dp = new Uint16Array((m + 1) * stride);
  for (let i = 1; i <= m; i += 1) {
    const row = i * stride;
    const prev = (i - 1) * stride;
    for (let j = 1; j <= n; j += 1) {
      dp[row + j] = beforeLines[i - 1] === afterLines[j - 1]
        ? dp[prev + (j - 1)] + 1
        : Math.max(dp[prev + j], dp[row + (j - 1)]);
    }
  }
  const common = dp[m * stride + n];
  const changedAfter = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      i -= 1; j -= 1;
    } else if (dp[(i - 1) * stride + j] >= dp[i * stride + (j - 1)]) {
      i -= 1;
    } else {
      changedAfter.push(j);
      j -= 1;
    }
  }
  while (j > 0) {
    changedAfter.push(j);
    j -= 1;
  }
  changedAfter.reverse();
  return { common, hunks: positionsToRanges(changedAfter) };
}

function positionsToRanges(positions) {
  if (!positions.length) return [];
  const ranges = [];
  let start = positions[0];
  let end = positions[0];
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] === end + 1) {
      end = positions[i];
    } else {
      ranges.push({ start, end });
      start = positions[i];
      end = positions[i];
    }
  }
  ranges.push({ start, end });
  return ranges;
}

function lineDiffCounts(beforeContent, afterContent) {
  const beforeLines = splitFileLines(beforeContent);
  const afterLines = splitFileLines(afterContent);
  const before = beforeLines.length;
  const after = afterLines.length;
  if (before > FILE_CHANGE_DIFF_LINE_LIMIT || after > FILE_CHANGE_DIFF_LINE_LIMIT) {
    return {
      before_lines: before,
      after_lines: after,
      unavailable_reason: "too_many_lines",
    };
  }

  if (before <= FILE_CHANGE_HUNK_LINE_LIMIT && after <= FILE_CHANGE_HUNK_LINE_LIMIT) {
    const { common, hunks } = fullLcsTableWithHunks(beforeLines, afterLines);
    const added = after - common;
    const removed = before - common;
    return {
      before_lines: before,
      after_lines: after,
      added_lines: added,
      removed_lines: removed,
      changed_lines: added + removed,
      hunks,
    };
  }

  const common = rollingLcsCount(beforeLines, afterLines);
  const added = after - common;
  const removed = before - common;
  return {
    before_lines: before,
    after_lines: after,
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
    const stats = { before_lines: 0, after_lines: afterLines, added_lines: afterLines, removed_lines: 0, changed_lines: afterLines };
    if (afterLines > 0) stats.hunks = [{ start: 1, end: afterLines }];
    return stats;
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
