export const ALLOWLIST_MODE_ALL = "all";
export const ALLOWLIST_MODE_CUSTOM = "custom";

export function normalizeList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()))]
    : [];
}

export function normalizeAllowlistMode(value) {
  if (value === ALLOWLIST_MODE_ALL || value === ALLOWLIST_MODE_CUSTOM) return value;
  throw new Error('allowlist mode must be "all" or "custom"');
}

export function storedAllowlistMode(value) {
  return value === ALLOWLIST_MODE_CUSTOM ? ALLOWLIST_MODE_CUSTOM : ALLOWLIST_MODE_ALL;
}

export function parseStoredAllowlist(value) {
  try {
    return normalizeList(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

export function inferAllowlistMode({ mode, list, fallback = ALLOWLIST_MODE_ALL } = {}) {
  if (mode !== undefined) return normalizeAllowlistMode(mode);
  return normalizeList(list).length > 0
    ? ALLOWLIST_MODE_CUSTOM
    : storedAllowlistMode(fallback);
}

export function resolveAllowlist({ mode, allowlist, all, getName = (item) => item }) {
  const normalizedMode = storedAllowlistMode(mode);
  if (normalizedMode === ALLOWLIST_MODE_ALL) return [...all];
  const allowed = new Set(normalizeList(allowlist));
  return all.filter((item) => allowed.has(getName(item)));
}

export function resolveAllowlistMap({ mode, allowlist, all }) {
  const normalizedMode = storedAllowlistMode(mode);
  if (normalizedMode === ALLOWLIST_MODE_ALL) return { ...all };
  const out = {};
  for (const name of normalizeList(allowlist)) {
    if (all[name]) out[name] = all[name];
  }
  return out;
}
