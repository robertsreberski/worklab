import { claudeModelSupportsOneMillionContext } from "@worklab-ai/agent-runtime/ai/runtime/context-windows.js";
import { codexModelSupportsFastMode } from "@worklab-ai/agent-runtime/ai/runtime/fast-mode.js";

function modelIdFromOption(option = {}) {
  if (!option) return "";
  if (option.model) return option.model;
  const value = String(option.value || "");
  const i = value.lastIndexOf(":");
  return i >= 0 ? value.slice(i + 1) : value;
}

function modelSdkFromOption(option = {}) {
  if (!option) return "";
  if (option.sdk) return option.sdk;
  return String(option.value || "").split(":", 1)[0] || "";
}

export function agentSupportsOneMillionContext(option) {
  return claudeModelSupportsOneMillionContext(modelIdFromOption(option));
}

export function agentSupportsFastMode(option) {
  return modelSdkFromOption(option) === "codex" && codexModelSupportsFastMode(modelIdFromOption(option));
}

export function memoryFreshnessLabel(memory) {
  switch (memory?.freshness) {
    case "current":
      return "Current";
    case "stale":
      return "Needs consolidation";
    case "not_consolidated":
      return memory?.exists ? "Needs consolidation" : "No memory yet";
    case "no_journal":
      return "No journal yet";
    case "consolidating":
      return "Consolidating";
    default:
      return "Loading";
  }
}

export function memoryFreshnessStatus(memory) {
  switch (memory?.freshness) {
    case "current":
      return "complete";
    case "stale":
    case "not_consolidated":
      return "review";
    case "consolidating":
      return "running";
    case "no_journal":
    default:
      return "disabled";
  }
}

export function formatMemoryBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMemoryTime(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function memoryMetaItems(memory) {
  if (!memory) return [{ label: "State", value: "Loading" }];
  const journalValue = !memory.journal_exists
    ? "No journal"
    : memory.journal_changed
      ? "Changed"
      : "Matched";
  return [
    { label: "State", value: memoryFreshnessLabel(memory), mono: false },
    { label: "Memory", value: memory.exists ? formatMemoryBytes(memory.size_bytes) : "Not written", mono: false },
    { label: "Updated", value: formatMemoryTime(memory.updated_at), mono: false },
    { label: "Consolidated", value: formatMemoryTime(memory.last_consolidated_at), mono: false },
    { label: "Journal", value: journalValue, mono: false },
    memory.last_run_id ? { label: "Run", value: memory.last_run_id, mono: true } : null,
  ].filter(Boolean);
}

export function memoryContentPlaceholder(memory) {
  if (!memory) return "Loading memory...";
  if (!memory.exists) return "No consolidated memory has been written yet.";
  return "";
}

export function learningMemoryStatusLabel(memory) {
  switch (memory?.status) {
    case "approved":
      return "Approved";
    case "archived":
      return "Archived";
    case "draft":
    default:
      return "Draft";
  }
}

export function learningMemoryStatusTone(memory) {
  switch (memory?.status) {
    case "approved":
      return "complete";
    case "archived":
      return "disabled";
    case "draft":
    default:
      return "review";
  }
}

export function learningMemoryMeta(memories = [], summary = null) {
  if (summary && typeof summary === "object") {
    return [
      { label: "Active", value: String(summary.active ?? 0) },
      { label: "Draft", value: String(summary.draft ?? 0) },
      { label: "Approved", value: String(summary.approved ?? 0) },
    ];
  }
  const active = (memories || []).filter((memory) => memory.status !== "archived");
  const draft = active.filter((memory) => memory.status === "draft").length;
  const approved = active.filter((memory) => memory.status === "approved").length;
  return [
    { label: "Active", value: String(active.length) },
    { label: "Draft", value: String(draft) },
    { label: "Approved", value: String(approved) },
  ];
}
