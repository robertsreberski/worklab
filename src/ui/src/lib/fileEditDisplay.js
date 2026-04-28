export function shortFilePath(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "");
}

export function fileEditKindLabel(kind) {
  if (typeof kind === "string" && kind.trim()) return kind.trim();
  if (kind && typeof kind === "object") {
    const type = typeof kind.type === "string" ? kind.type.trim() : "";
    const movePath = typeof kind.move_path === "string" ? kind.move_path.trim() : "";
    if (type && movePath) return `${type} -> ${shortFilePath(movePath)}`;
    if (type) return type;
  }
  return "change";
}

export function fileEditLineDelta(stats = {}) {
  const added = Number(stats.added_lines);
  const removed = Number(stats.removed_lines);
  if (Number.isFinite(added) || Number.isFinite(removed)) {
    return `+${Number.isFinite(added) ? added : 0} -${Number.isFinite(removed) ? removed : 0}`;
  }
  const before = Number(stats.before_lines);
  const after = Number(stats.after_lines);
  if (Number.isFinite(before) && Number.isFinite(after)) return `${before}->${after} lines`;
  return "";
}

export function fileEditChangeLabel(change = {}) {
  const kind = fileEditKindLabel(change.kind);
  const path = shortFilePath(change.path || "");
  const delta = fileEditLineDelta(change.line_stats);
  return `${kind} ${path}${delta ? ` (${delta})` : ""}`.trim();
}
