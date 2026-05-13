import { join } from "node:path";
import { buildSkillIndex } from "../skills.js";
import { getAvailableMcpServers } from "../mcp-config.js";

export function section(title, body) {
  const text = String(body || "").trim();
  return text ? `## ${title}\n\n${text}\n` : "";
}

export function clip(text, maxChars = 5000) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export function renderSkills(skills) {
  const enabled = (skills || []).filter((skill) => skill.enabled !== false);
  return enabled.length ? buildSkillIndex(enabled).trim() : "";
}

export function formatHistory(messages = []) {
  return messages.map((message) => {
    const who = message.role === "assistant" ? "Assistant" : "User";
    const status = message.status && message.status !== "complete" ? ` (${message.status})` : "";
    return `${who}${status}: ${clip(message.body, 1200)}`;
  }).filter(Boolean).join("\n\n");
}

function adminMcpServer(config) {
  return {
    command: process.execPath,
    args: [join(config.repoRoot, "src", "cli", "index.js"), "mcp"],
    env: {
      WORKLAB_DATA_DIR: config.dataDir,
      WORKLAB_HOST: config.host,
      WORKLAB_PORT: String(config.port),
      WORKLAB_WORKSPACE: config.workspace,
    },
  };
}

export function assistantMcpServers(config) {
  return {
    ...getAvailableMcpServers(config.dataDir, { repoRoot: config.repoRoot }),
    worklab: adminMcpServer(config),
  };
}

export function abortSignalWithTimeout(ms, parentSignal) {
  const ac = new AbortController();
  let details = null;
  const abortWith = ({ kind, initiator, message, reason }) => {
    if (ac.signal.aborted) return;
    details = { kind, initiator, message, reason: reason || message || null };
    ac.abort(Object.assign(new Error(message || "assistant run aborted"), details));
  };
  const onAbort = () => abortWith({
    kind: "parent_abort",
    initiator: "parent",
    message: parentSignal?.reason?.message || "assistant run aborted",
    reason: parentSignal?.reason?.message || null,
  });
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = Number.isFinite(Number(ms)) && Number(ms) > 0
    ? setTimeout(() => abortWith({
      kind: "timeout",
      initiator: "assistant_timeout",
      message: `assistant run timed out after ${Number(ms)}ms`,
    }), Number(ms))
    : null;
  timeout?.unref?.();
  return {
    signal: ac.signal,
    cancel: (options = {}) => abortWith({
      kind: "user_cancel",
      initiator: options.initiator || "api_cancel",
      message: "Assistant run cancelled",
      reason: options.reason || "user requested cancellation",
    }),
    details: () => details,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
    },
  };
}
