import { DEFAULT_EMBEDDING_MODEL, parseEmbeddingReference } from "./embeddings.js";

export const DEFAULT_SETTINGS = {
  consolidation_hour: 3,
  consolidation_enabled: true,
  default_embedding_model: DEFAULT_EMBEDDING_MODEL,
  journal_tail_lines: 80,
  kb_pinned_limit: 10,
  worker_timeout_ms: 1800000,
  cancel_grace_ms: 5000,
};

function coerceStored(value) {
  try { return JSON.parse(value); } catch { return value; }
}

export function readSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = coerceStored(row.value);
  return out;
}

function integerInRange(key, value, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function validateSetting(key, value) {
  switch (key) {
    case "consolidation_hour":
      return integerInRange(key, value, { min: 0, max: 23 });
    case "consolidation_enabled":
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      return value;
    case "default_embedding_model":
      if (value == null || value === "") return "";
      return parseEmbeddingReference(value).reference;
    case "journal_tail_lines":
      return integerInRange(key, value, { min: 0, max: 1000 });
    case "kb_pinned_limit":
      return integerInRange(key, value, { min: 0, max: 100 });
    case "worker_timeout_ms":
      return integerInRange(key, value, { min: 1000, max: Number.MAX_SAFE_INTEGER });
    case "cancel_grace_ms":
      return integerInRange(key, value, { min: 0, max: Number.MAX_SAFE_INTEGER });
    default:
      throw new Error(`unknown setting: ${key}`);
  }
}

export function validateSettingsPatch(patch = {}) {
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULT_SETTINGS));
  if (unknown.length) throw new Error(`unknown keys: ${unknown.join(",")}`);
  const out = {};
  for (const [key, value] of Object.entries(patch)) out[key] = validateSetting(key, value);
  return out;
}

export function writeSettings(db, patch = {}) {
  const validated = validateSettingsPatch(patch);
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) stmt.run(key, JSON.stringify(value));
  });
  tx(Object.entries(validated));
  return readSettings(db);
}
