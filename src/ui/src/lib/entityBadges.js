export const ENTITY_BADGE_META = {
  task: { label: "Task", glyph: "T" },
  project: { label: "Project", glyph: "P" },
  kb: { label: "Knowledge", icon: "book" },
  knowledge: { label: "Knowledge", icon: "book" },
  skill: { label: "Skill", glyph: "S" },
  agent: { label: "Agent", glyph: "A" },
  goal: { label: "Goal", glyph: "G" },
  team: { label: "Team", icon: "users" },
  run: { label: "Run", glyph: "R" },
};

export function normalizeEntityBadgeKind(kind) {
  const key = String(kind || "").toLowerCase();
  return key === "knowledge" ? "kb" : key;
}

export function entityBadgeMeta(kind) {
  const normalized = normalizeEntityBadgeKind(kind);
  return ENTITY_BADGE_META[normalized] || { label: "Reference", glyph: "?" };
}

export function entityBadgeFallback(kind) {
  const meta = entityBadgeMeta(kind);
  return `Unknown ${meta.label || "Reference"}`;
}

export function entityBadgeLabel({ label, type } = {}) {
  const resolved = String(label || "").trim();
  if (resolved) return resolved.replace(/^@/, "");
  return entityBadgeFallback(type);
}
