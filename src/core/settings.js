import { DEFAULT_EMBEDDING_MODEL, parseEmbeddingReference } from "./embeddings.js";
import { isValidModelReference } from "./ai.js";

export const DEFAULT_SETTINGS = {
  consolidation_hour: 3,
  consolidation_enabled: true,
  default_embedding_model: DEFAULT_EMBEDDING_MODEL,
  journal_tail_lines: 80,
  kb_pinned_limit: 10,
  worker_timeout_ms: 1800000,
  cancel_grace_ms: 5000,
  daily_budget_usd: 0,
  max_failure_streak: 3,
  max_rejection_streak: 3,
  slack_enabled: false,
  slack_user_id: "",
  slack_agent_name: "assistant",
  slack_model: "codex:gpt-5.5",
  slack_effort: "xhigh",
  slack_channel_ids: [],
  slack_run_timeout_ms: 120000,
  slack_notify_task_completed: true,
  slack_notify_task_errors: true,
  assistant_model: "openai:gpt-5.5",
  assistant_effort: "high",
  assistant_run_timeout_ms: 300000,
  assistant_max_turns: 32,
};

const AGENT_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

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

function stringValue(key, value, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${key} is required`);
  return text;
}

function stringArray(key, value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]/);
  return raw.map((item) => String(item || "").trim()).filter(Boolean);
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
    case "daily_budget_usd": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
      return n;
    }
    case "max_failure_streak":
    case "max_rejection_streak":
      return integerInRange(key, value, { min: 1, max: 100 });
    case "slack_enabled":
    case "slack_notify_task_completed":
    case "slack_notify_task_errors":
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      return value;
    case "slack_user_id":
    case "slack_agent_name":
      return stringValue(key, value);
    case "slack_model": {
      const text = stringValue(key, value, { required: true });
      if (!isValidModelReference(text)) throw new Error(`${key} must be a valid model reference`);
      return text;
    }
    case "slack_effort": {
      const text = stringValue(key, value, { required: true });
      if (!AGENT_EFFORTS.has(text)) throw new Error(`${key} must be one of: ${[...AGENT_EFFORTS].join(", ")}`);
      return text;
    }
    case "slack_channel_ids":
      return stringArray(key, value);
    case "slack_run_timeout_ms":
      return integerInRange(key, value, { min: 1000, max: Number.MAX_SAFE_INTEGER });
    case "assistant_model": {
      const text = stringValue(key, value, { required: true });
      if (!isValidModelReference(text)) throw new Error(`${key} must be a valid model reference`);
      return text;
    }
    case "assistant_effort": {
      const text = stringValue(key, value, { required: true });
      if (!AGENT_EFFORTS.has(text)) throw new Error(`${key} must be one of: ${[...AGENT_EFFORTS].join(", ")}`);
      return text;
    }
    case "assistant_run_timeout_ms":
      return integerInRange(key, value, { min: 1000, max: Number.MAX_SAFE_INTEGER });
    case "assistant_max_turns":
      return integerInRange(key, value, { min: 1, max: 200 });
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
