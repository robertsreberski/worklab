import { DEFAULT_EMBEDDING_MODEL, parseEmbeddingReference } from "./embeddings.js";
import {
  DEFAULT_PLANNING_HARNESS,
  DEFAULT_PLANNING_TOOL_POLICY,
  validatePlanningHarnessSetting,
  validatePlanningToolPolicySetting,
} from "./planning-harness.js";
import { normalizeRuntimeModelReference } from "../ai/runtime/model-refs.js";
import { listSettings, upsertSetting } from "./db/queries/settings.js";

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
  slack_agent_name: "mickey",
  slack_model: "pi:openai-codex:gpt-5.5",
  slack_effort: "xhigh",
  slack_channel_ids: [],
  slack_run_timeout_ms: 120000,
  slack_notify_task_completed: true,
  slack_notify_task_errors: true,
  assistant_model: "pi:openai-codex:gpt-5.5",
  assistant_effort: "high",
  assistant_run_timeout_ms: 300000,
  assistant_max_turns: 32,
  agent_budget_soft_turns: 150,
  agent_budget_hard_turns: 300,
  agent_compaction_enabled: true,
  agent_compaction_trigger_ratio: 0.85,
  agent_compaction_keep_recent_tokens: 24000,
  agent_compaction_summary_max_tokens: 16000,
  agent_compaction_min_savings_tokens: 20000,
  agent_tool_payload_compaction_trigger_chars: 0,
  agent_tool_prune_trigger_tokens: 40000,
  // intelligence-ramp Phase 3: lifted from 16K/20K/12K to give the agent
  // room to actually read the files / output it just asked for. tool_bloat.js
  // still hard-caps at 256 KB.
  agent_tool_text_limit_chars: 64000,
  agent_bash_output_limit_chars: 64000,
  agent_mcp_text_limit_chars: 48000,
  agent_search_result_limit: 100,
  agent_image_inline_max_bytes: 250000,
  agent_tool_payload_max_bytes: 262144,
  agent_mcp_call_timeout_ms: 120000,
  agent_review_idle_threshold_ms: 240000,
  agent_recovery_continuation_limit: 3,
  agent_provider_recovery_enabled: true,
  agent_provider_recovery_base_delay_ms: 30000,
  // intelligence-ramp Phase 4: gate the review→done transition on
  // verification_evidence. "warn" (default) emits a runtime warning but still
  // approves; "block" refuses the transition; "off" disables the gate
  // entirely. Soft-launch defaults to "warn" so operators can see what
  // would have been bounced before flipping to block.
  agent_verification_gate_mode: "warn",
  planning_harness: DEFAULT_PLANNING_HARNESS,
  planning_tool_policy: DEFAULT_PLANNING_TOOL_POLICY,
  agent_learning_enabled: true,
  agent_learning_injected_limit: 6,
  agent_learning_auto_approve_threshold: 0.85,
  delegation_enabled: true,
  delegation_max_depth: 1,
  delegation_max_children_per_round: 5,
  delegation_max_parallel_children: 3,
  delegation_auto_run_children: true,
};

const AGENT_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function coerceStored(value) {
  try { return JSON.parse(value); } catch { return value; }
}

export function readSettings(db) {
  const rows = listSettings(db);
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) out[row.key] = coerceStored(row.value);
  }
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

function numberInRange(key, value, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return n;
}

function agentRuntimeModelReference(key, value) {
  const text = stringValue(key, value, { required: true });
  try {
    const normalized = normalizeRuntimeModelReference(text);
    if (normalized.sdk === "codex") {
      throw new Error("codex cli refs require an agent execution_mode");
    }
    return normalized.reference;
  } catch {
    throw new Error(`${key} must be a valid model reference`);
  }
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
    case "slack_model":
      return agentRuntimeModelReference(key, value);
    case "slack_effort": {
      const text = stringValue(key, value, { required: true });
      if (!AGENT_EFFORTS.has(text)) throw new Error(`${key} must be one of: ${[...AGENT_EFFORTS].join(", ")}`);
      return text;
    }
    case "slack_channel_ids":
      return stringArray(key, value);
    case "slack_run_timeout_ms":
      return integerInRange(key, value, { min: 1000, max: Number.MAX_SAFE_INTEGER });
    case "assistant_model":
      return agentRuntimeModelReference(key, value);
    case "assistant_effort": {
      const text = stringValue(key, value, { required: true });
      if (!AGENT_EFFORTS.has(text)) throw new Error(`${key} must be one of: ${[...AGENT_EFFORTS].join(", ")}`);
      return text;
    }
    case "assistant_run_timeout_ms":
      return integerInRange(key, value, { min: 1000, max: Number.MAX_SAFE_INTEGER });
    case "assistant_max_turns":
      return integerInRange(key, value, { min: 1, max: 200 });
    case "agent_budget_soft_turns":
    case "agent_budget_hard_turns":
      return integerInRange(key, value, { min: 1, max: 10000 });
    case "agent_compaction_enabled":
    case "agent_provider_recovery_enabled":
    case "delegation_enabled":
    case "delegation_auto_run_children":
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      return value;
    case "agent_compaction_trigger_ratio":
      return numberInRange(key, value, { min: 0.2, max: 0.95 });
    case "agent_compaction_keep_recent_tokens":
      return integerInRange(key, value, { min: 4000, max: 200000 });
    case "agent_compaction_summary_max_tokens":
      return integerInRange(key, value, { min: 1000, max: 64000 });
    case "agent_compaction_min_savings_tokens":
      return integerInRange(key, value, { min: 0, max: 500000 });
    case "agent_tool_payload_compaction_trigger_chars":
      return integerInRange(key, value, { min: 0, max: 10 * 1024 * 1024 });
    case "agent_tool_prune_trigger_tokens":
      return integerInRange(key, value, { min: 0, max: 500000 });
    case "agent_tool_text_limit_chars":
    case "agent_bash_output_limit_chars":
    case "agent_mcp_text_limit_chars":
      return integerInRange(key, value, { min: 1000, max: 200000 });
    case "agent_search_result_limit":
      return integerInRange(key, value, { min: 10, max: 1000 });
    case "agent_image_inline_max_bytes":
      return integerInRange(key, value, { min: 0, max: 10 * 1024 * 1024 });
    case "agent_tool_payload_max_bytes":
      return integerInRange(key, value, { min: 0, max: 16 * 1024 * 1024 });
    case "agent_review_idle_threshold_ms":
      return integerInRange(key, value, { min: 0, max: Number.MAX_SAFE_INTEGER });
    case "agent_mcp_call_timeout_ms":
      return integerInRange(key, value, { min: 1000, max: Number.MAX_SAFE_INTEGER });
    case "agent_recovery_continuation_limit":
      return integerInRange(key, value, { min: 0, max: 20 });
    case "agent_provider_recovery_base_delay_ms":
      return integerInRange(key, value, { min: 0, max: 300000 });
    case "agent_verification_gate_mode": {
      if (typeof value !== "string") throw new Error(`${key} must be a string`);
      const trimmed = value.trim();
      if (!["off", "warn", "block"].includes(trimmed)) {
        throw new Error(`${key} must be one of: off, warn, block`);
      }
      return trimmed;
    }
    case "planning_harness":
      return validatePlanningHarnessSetting(key, value);
    case "planning_tool_policy":
      return validatePlanningToolPolicySetting(key, value);
    case "agent_learning_enabled":
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      return value;
    case "agent_learning_injected_limit":
      return integerInRange(key, value, { min: 1, max: 25 });
    case "agent_learning_auto_approve_threshold":
      return numberInRange(key, value, { min: 0, max: 1 });
    case "delegation_max_depth":
      return integerInRange(key, value, { min: 0, max: 10 });
    case "delegation_max_children_per_round":
      return integerInRange(key, value, { min: 1, max: 50 });
    case "delegation_max_parallel_children":
      return integerInRange(key, value, { min: 1, max: 50 });
    default:
      throw new Error(`unknown setting: ${key}`);
  }
}

export function validateSettingsPatch(patch = {}, baseSettings = DEFAULT_SETTINGS) {
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULT_SETTINGS));
  if (unknown.length) throw new Error(`unknown keys: ${unknown.join(",")}`);
  const out = {};
  for (const [key, value] of Object.entries(patch)) out[key] = validateSetting(key, value);
  const merged = { ...DEFAULT_SETTINGS, ...(baseSettings || {}), ...out };
  if (Number(merged.agent_budget_soft_turns) > Number(merged.agent_budget_hard_turns)) {
    throw new Error("agent_budget_soft_turns must be less than or equal to agent_budget_hard_turns");
  }
  return out;
}

export function writeSettings(db, patch = {}) {
  const validated = validateSettingsPatch(patch, readSettings(db));
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) upsertSetting(db, key, JSON.stringify(value));
  });
  tx(Object.entries(validated));
  return readSettings(db);
}
