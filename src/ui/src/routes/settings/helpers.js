import { modelOptionDescription } from "../../lib/display.js";

export const LOG_LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"].map((value) => ({ value, label: value }));
export const SLACK_EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }));
export const MCP_TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" },
];

export function jsonEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function minutesValue(ms) {
  if (ms === "" || ms == null) return "";
  const minutes = Number(ms) / 60000;
  if (!Number.isFinite(minutes)) return "";
  return Number(minutes.toFixed(4)).toString();
}

export function minutesToMs(value) {
  if (value === "") return "";
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return "";
  return Math.round(minutes * 60000);
}

export function secondsValue(ms) {
  if (ms === "" || ms == null) return "";
  const seconds = Number(ms) / 1000;
  if (!Number.isFinite(seconds)) return "";
  return Number(seconds.toFixed(2)).toString();
}

export function secondsToMs(value) {
  if (value === "") return "";
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  return Math.round(seconds * 1000);
}

export function numberOrEmpty(value) {
  if (value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

export function listFromText(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function textFromList(value) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

export function parseJsonObject(text, label) {
  if (!String(text || "").trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${err.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

export function mcpRowsFromServers(servers = {}) {
  return Object.entries(servers).map(([name, config], index) => {
    const transport = config?.type === "http" || config?.type === "sse" ? config.type : "stdio";
    return {
      id: `${name}-${index}`,
      name,
      transport,
      command: config?.command || "",
      argsText: Array.isArray(config?.args) ? config.args.join("\n") : "",
      envText: config?.env ? JSON.stringify(config.env, null, 2) : "",
      url: config?.url || "",
      headersText: config?.headers ? JSON.stringify(config.headers, null, 2) : "",
    };
  });
}

export function mcpServersFromRows(rows = []) {
  const servers = {};
  for (const row of rows) {
    const name = String(row.name || "").trim();
    if (!name) throw new Error("MCP server name is required");
    if (servers[name]) throw new Error(`Duplicate MCP server name: ${name}`);
    if (row.transport === "http" || row.transport === "sse") {
      if (!String(row.url || "").trim()) throw new Error(`MCP server ${name} requires a URL`);
      const next = { type: row.transport, url: String(row.url).trim() };
      const headers = parseJsonObject(row.headersText, `${name} headers`);
      if (headers) next.headers = headers;
      servers[name] = next;
    } else {
      if (!String(row.command || "").trim()) throw new Error(`MCP server ${name} requires an absolute command path`);
      const args = String(row.argsText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const env = parseJsonObject(row.envText, `${name} env`);
      const next = { command: String(row.command).trim() };
      if (args.length) next.args = args;
      if (env) next.env = env;
      servers[name] = next;
    }
  }
  return servers;
}

export function runtimePayload(runtimeDraft = {}) {
  return {
    host: runtimeDraft.host,
    port: Number(runtimeDraft.port),
    workspace: runtimeDraft.workspace,
    logLevel: runtimeDraft.logLevel,
    timezone: runtimeDraft.timezone || "",
    runIdleWarningMs: Number(runtimeDraft.runIdleWarningMs),
    logInlineLimit: Number(runtimeDraft.logInlineLimit),
  };
}

export function settingsPayload(settings = {}) {
  return {
    consolidation_hour: Number(settings.consolidation_hour),
    consolidation_enabled: !!settings.consolidation_enabled,
    worker_timeout_ms: Number(settings.worker_timeout_ms),
    cancel_grace_ms: Number(settings.cancel_grace_ms),
    journal_tail_lines: Number(settings.journal_tail_lines),
    kb_pinned_limit: Number(settings.kb_pinned_limit),
    default_embedding_model: settings.default_embedding_model || "",
    slack_enabled: !!settings.slack_enabled,
    slack_user_id: settings.slack_user_id || "",
    slack_agent_name: settings.slack_agent_name || "mickey",
    slack_model: settings.slack_model || "codex:gpt-5.5",
    slack_effort: settings.slack_effort || "xhigh",
    slack_channel_ids: Array.isArray(settings.slack_channel_ids)
      ? settings.slack_channel_ids
      : listFromText(settings.slack_channel_ids),
    slack_run_timeout_ms: Number(settings.slack_run_timeout_ms ?? 120000),
    slack_notify_task_completed: settings.slack_notify_task_completed !== false,
    slack_notify_task_errors: settings.slack_notify_task_errors !== false,
    assistant_model: settings.assistant_model || "openai:gpt-5.5",
    assistant_effort: settings.assistant_effort || "high",
    assistant_run_timeout_ms: Number(settings.assistant_run_timeout_ms ?? 300000),
    assistant_max_turns: Number(settings.assistant_max_turns ?? 32),
    delegation_enabled: settings.delegation_enabled !== false,
    delegation_max_depth: Number(settings.delegation_max_depth ?? 1),
    delegation_max_children_per_round: Number(settings.delegation_max_children_per_round ?? 5),
    delegation_max_parallel_children: Number(settings.delegation_max_parallel_children ?? 3),
    delegation_auto_run_children: settings.delegation_auto_run_children !== false,
    agent_compaction_enabled: settings.agent_compaction_enabled !== false,
    agent_compaction_trigger_ratio: Number(settings.agent_compaction_trigger_ratio ?? 0.85),
    agent_compaction_keep_recent_tokens: Number(settings.agent_compaction_keep_recent_tokens ?? 24000),
    agent_compaction_summary_max_tokens: Number(settings.agent_compaction_summary_max_tokens ?? 16000),
    agent_compaction_min_savings_tokens: Number(settings.agent_compaction_min_savings_tokens ?? 20000),
    agent_tool_payload_compaction_trigger_chars: Number(settings.agent_tool_payload_compaction_trigger_chars ?? 0),
    agent_tool_prune_trigger_tokens: Number(settings.agent_tool_prune_trigger_tokens ?? 40000),
    agent_tool_text_limit_chars: Number(settings.agent_tool_text_limit_chars ?? 16000),
    agent_bash_output_limit_chars: Number(settings.agent_bash_output_limit_chars ?? 20000),
    agent_mcp_text_limit_chars: Number(settings.agent_mcp_text_limit_chars ?? 12000),
    agent_search_result_limit: Number(settings.agent_search_result_limit ?? 100),
    agent_image_inline_max_bytes: Number(settings.agent_image_inline_max_bytes ?? 250000),
    agent_mcp_call_timeout_ms: Number(settings.agent_mcp_call_timeout_ms ?? 120000),
    agent_recovery_continuation_limit: Number(settings.agent_recovery_continuation_limit ?? 3),
    agent_provider_recovery_enabled: settings.agent_provider_recovery_enabled !== false,
    agent_provider_recovery_base_delay_ms: Number(settings.agent_provider_recovery_base_delay_ms ?? 30000),
  };
}

export function notificationStatus(settings) {
  if (!settings?.supported) return { status: "disabled", label: "Unsupported" };
  if (settings.permission === "denied") return { status: "error", label: "Blocked" };
  if (settings.enabled) return { status: "enabled", label: "On" };
  return { status: "disabled", label: "Off" };
}

export function notificationDescription(settings) {
  if (!settings?.supported) return "This browser does not support notifications.";
  if (settings.permission === "denied") return "Browser permission is blocked for this site.";
  return "Task run starts, completions, and errors in background tabs.";
}

export function slackUserMatchesBot(settings = {}, status = {}) {
  return !!(settings?.slack_user_id && status?.bot_user_id && settings.slack_user_id === status.bot_user_id);
}

export function slackRejectedSenderLabel(status = {}) {
  if (!status?.last_rejected) return "-";
  const parts = [];
  if (status.last_rejected.reason) parts.push(status.last_rejected.reason);
  if (status.last_rejected.user) parts.push(status.last_rejected.user);
  return parts.join(" / ") || "-";
}

export function slackStatusMeta(status, settings) {
  if (!status?.enabled) return { status: "disabled", label: "Off" };
  if (slackUserMatchesBot(settings, status)) return { status: "error", label: "Bot ID configured" };
  if (!status?.token_present?.bot || !status?.token_present?.app) return { status: "error", label: "Missing tokens" };
  if (status.connected) return { status: "enabled", label: "Connected" };
  if (status.reason === "start_failed") return { status: "error", label: "Start failed" };
  return { status: "running", label: "Configured" };
}

export function serviceStatusMeta(runtime) {
  if (!runtime) return { status: "error", label: "Unavailable" };
  if (runtime.restartRequired) return { status: "running", label: "Restart pending" };
  if (runtime.service?.installed) {
    return {
      status: "enabled",
      label: runtime.service.platform ? `Installed (${runtime.service.platform})` : "Installed",
    };
  }
  return { status: "disabled", label: "Not installed" };
}

export function searchIndexMeta(status) {
  if (!status) return { status: "disabled", label: "Unknown" };
  if (Number(status.errors || 0) > 0) return { status: "error", label: "Has errors" };
  if (status.model && status.ready === false) return { status: "running", label: "Paused" };
  if (status.ready) return { status: "enabled", label: "Ready" };
  if (!status.model) return { status: "disabled", label: "No model" };
  return { status: "running", label: "Indexing" };
}

export function mcpAvailabilitySummary(status = {}, rows = []) {
  const servers = status?.servers || [];
  const unavailable = servers.filter((server) => server.available === false).length;
  const builtin = servers.filter((server) => server.source === "builtin").length;
  const user = rows.length;
  if (status?.config_error) return { status: "error", label: "Config error", builtin, user, unavailable };
  if (unavailable) return { status: "error", label: `${unavailable} unavailable`, builtin, user, unavailable };
  return { status: "enabled", label: "Available", builtin, user, unavailable };
}

export function scrollToSettingsSection(id) {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function modelSelectOptions(modelGroups, currentModel) {
  const allModelValues = modelGroups.flatMap((g) => (g.models || []).map((m) => m.value));
  return [
    ...(currentModel && !allModelValues.includes(currentModel)
      ? [{ label: "Current", options: [{ value: currentModel, label: `${currentModel} (custom)` }] }]
      : []),
    ...modelGroups.map((g) => ({
      label: g.available === false ? `${g.label} (credentials not set)` : g.label,
      options: (g.models || []).map((m) => ({
        value: m.value,
        label: m.label || m.value,
        description: modelOptionDescription(m, g),
        disabled: g.available === false || m.available === false || m.disabled === true,
      })),
    })),
  ];
}
