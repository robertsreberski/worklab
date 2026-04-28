import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { normalizeReasoningEffortForModel } from "./ai.js";
import { getSkillAccessDirs } from "./skills.js";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  extractWorklabResult,
  formatWorklabResultText,
  parseStandaloneWorklabResultText,
  stripWorklabResultJson,
} from "./worklab-result.js";
import { normalizeCodexItemEvent } from "./codex-events.js";

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n")
    : String(messages || "");
}

const CODEX_REASONING_ITEM_EVENTS = new Set(["item.started", "item.updated", "item.completed"]);
const CODEX_REASONING_EVENT_TYPES = new Set([
  "agent_reasoning",
  "agent_reasoning_delta",
  "reasoning_content_delta",
  "reasoning_summary_part_added",
  "reasoning_summary_text_delta",
]);
const CODEX_RAW_REASONING_EVENT_TYPES = new Set([
  "agent_reasoning_raw_content",
  "agent_reasoning_raw_content_delta",
  "reasoning_raw_content",
  "reasoning_raw_content_delta",
]);
const CODEX_FILE_CHANGE_ITEM_EVENTS = new Set(["item.started", "item.completed"]);
const FILE_CHANGE_SNAPSHOT_LIMIT_BYTES = 300_000;
const FILE_CHANGE_DIFF_LINE_LIMIT = 4000;

function summaryTextFromValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(summaryTextFromValue).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  if (value.type && !["summary_text", "reasoning_summary_text"].includes(value.type)) return "";
  return summaryTextFromValue(value.text ?? value.delta ?? value.summary ?? value.content);
}

function codexReasoningSummaryText(raw) {
  const item = raw?.item || {};
  return [
    raw?.delta,
    raw?.text,
    raw?.summary,
    raw?.content,
    item.delta,
    item.text,
    item.summary,
    item.summaries,
  ].map(summaryTextFromValue).find((text) => text.trim()) || "";
}

function isCodexReasoningEvent(raw) {
  if (!raw || typeof raw !== "object") return false;
  return CODEX_REASONING_EVENT_TYPES.has(raw.type)
    || CODEX_RAW_REASONING_EVENT_TYPES.has(raw.type)
    || (CODEX_REASONING_ITEM_EVENTS.has(raw.type) && raw.item?.type === "reasoning");
}

function splitFileLines(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readFileChangeSnapshot(path) {
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

function lineDiffCounts(beforeContent, afterContent) {
  const beforeLines = splitFileLines(beforeContent);
  const afterLines = splitFileLines(afterContent);
  if (beforeLines.length > FILE_CHANGE_DIFF_LINE_LIMIT || afterLines.length > FILE_CHANGE_DIFF_LINE_LIMIT) {
    return {
      before_lines: beforeLines.length,
      after_lines: afterLines.length,
      unavailable_reason: "too_many_lines",
    };
  }

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

  const common = previous[afterLines.length];
  const added = afterLines.length - common;
  const removed = beforeLines.length - common;
  return {
    before_lines: beforeLines.length,
    after_lines: afterLines.length,
    added_lines: added,
    removed_lines: removed,
    changed_lines: added + removed,
  };
}

function statsForCompletedChange(change, before, after) {
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
    return { before_lines: 0, after_lines: afterLines, added_lines: afterLines, removed_lines: 0, changed_lines: afterLines };
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

function fileChangeSummary(changes) {
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

function normalizeCodexFileChange(raw, context = {}) {
  if (!CODEX_FILE_CHANGE_ITEM_EVENTS.has(raw?.type) || raw.item?.type !== "file_change") return null;
  const item = raw.item;
  const id = item.id || "file_change";
  const snapshots = context.fileChangeSnapshots || new Map();
  const cwd = context.cwd || process.cwd();
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
  const summary = fileChangeSummary(changes);
  const payload = {
    changes,
    status: item.status || (raw.type === "item.completed" ? "completed" : "in_progress"),
    ...(summary ? { summary } : {}),
  };
  if (raw.type === "item.started") {
    return { type: "assistant", message: { content: [{ type: "tool_use", id, name: "file_edit", input: payload }] } };
  }
  const failed = Boolean(item.error || item.status === "failed" || item.status === "errored");
  return {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: id,
        content: item.error || payload,
        is_error: failed,
      }],
    },
  };
}

function normalizeCliEvent(raw, context = {}) {
  if (!raw || typeof raw !== "object") return { type: "cli_event", raw };
  const fileChange = normalizeCodexFileChange(raw, context);
  if (fileChange) return fileChange;
  if (CODEX_RAW_REASONING_EVENT_TYPES.has(raw.type)) return null;
  if (CODEX_REASONING_EVENT_TYPES.has(raw.type) || (CODEX_REASONING_ITEM_EVENTS.has(raw.type) && raw.item?.type === "reasoning")) {
    const text = codexReasoningSummaryText(raw).trim();
    return text
      ? { type: "assistant", message: { content: [{ type: "thinking", text }] } }
      : null;
  }
  if (raw.type === "assistant" || raw.type === "user" || raw.type === "result" || raw.type === "error") return raw;
  if (raw.type === "message" && raw.message) return { type: "assistant", message: raw.message };
  if (raw.type === "item.completed" && raw.item?.type === "agent_message" && typeof raw.item.text === "string") {
    const result = parseStandaloneWorklabResultText(raw.item.text);
    if (result) {
      return {
        type: "worklab_result_candidate",
        source: "agent_message",
        text: raw.item.text,
        worklab_result: result,
      };
    }
    return { type: "assistant", message: { content: [{ type: "text", text: raw.item.text }] } };
  }
  const codexItem = normalizeCodexItemEvent(raw);
  if (codexItem) return codexItem;
  if (raw.type === "tool_call") {
    return { type: "assistant", message: { content: [{ type: "tool_use", id: raw.id, name: raw.name, input: raw.input || raw.arguments }] } };
  }
  if (raw.type === "tool_result") {
    return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: raw.id || raw.tool_use_id, content: raw.output || raw.result || "" }] } };
  }
  return { type: "cli_event", raw };
}

function textFromEvent(raw) {
  if (typeof raw?.text === "string") return raw.text;
  if (typeof raw?.item?.text === "string") return raw.item.text;
  if (raw?.type === "result" && raw.result != null) {
    return typeof raw.result === "string" ? raw.result : JSON.stringify(raw.result);
  }
  if (raw?.final_output != null) {
    return typeof raw.final_output === "string" ? raw.final_output : JSON.stringify(raw.final_output);
  }
  if (typeof raw?.message?.content === "string") return raw.message.content;
  if (Array.isArray(raw?.message?.content)) {
    return raw.message.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
  }
  return "";
}

function inferStructuredResultSource(raw) {
  if (raw?.type === "result" && raw.result != null) return "result";
  if (raw?.final_output != null) return "final_output";
  const blocks = raw?.message?.content || raw?.content;
  if (Array.isArray(blocks) && blocks.some((block) => block?.type === "tool_use" && block?.name === "StructuredOutput")) {
    return "StructuredOutput";
  }
  if (raw?.type === "tool_call" && raw.name === "StructuredOutput") return "StructuredOutput";
  if (raw?.item?.type === "agent_message") return "agent_message";
  return "event";
}

function stringifyError(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function humanizeSubtype(subtype) {
  return String(subtype || "").replace(/^error_/, "").replace(/_/g, " ").trim();
}

function resultEventError(raw, command) {
  if (raw?.type !== "result") return null;
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
  const errors = Array.isArray(raw.errors) ? raw.errors.filter(Boolean) : [];
  const explicit = stringifyError(raw.error) || stringifyError(raw.message);
  if (!raw.is_error && !subtype.startsWith("error_") && errors.length === 0 && !explicit) return null;

  const runtime = command === "claude" ? "Claude Code" : command === "codex" ? "Codex" : command || "CLI";
  const detail = explicit || errors.map(stringifyError).filter(Boolean).join("; ");
  const label = humanizeSubtype(subtype);
  const message = subtype === "error_max_turns"
    ? `${runtime} stopped before final output: max turns reached`
    : `${runtime} result error${label ? ` (${label})` : ""}${detail ? `: ${detail}` : ""}`;
  return {
    message,
    failureKind: subtype === "error_max_turns" ? "usage_limit" : "provider_unavailable",
  };
}

function pushUniqueText(texts, text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return;
  if (texts.some((existing) => existing.trim() === value)) return;
  texts.push(value);
}

function finalTextFromCliOutput(worklabResult, texts) {
  const delivered = stripWorklabResultJson(texts[texts.length - 1] || "");
  return delivered || formatWorklabResultText(worklabResult);
}

function parseJsonError(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error || parsed;
  } catch {
    return null;
  }
}

function formatCliError(message, command) {
  const raw = String(message || "").trim();
  const parsed = parseJsonError(raw);
  const code = parsed?.code || parsed?.error?.code;
  const detail = parsed?.message || parsed?.error?.message;
  const param = parsed?.param || parsed?.error?.param;
  if (code === "invalid_json_schema" || /invalid_json_schema|Invalid schema/i.test(raw)) {
    return `Invalid response schema${param ? ` (${param})` : ""}: ${detail || raw}`;
  }
  if (
    command === "claude" &&
    (/401|Unauthorized|OAuth token is invalid|Please run \/login|auth/i.test(raw))
  ) {
    return "Claude Code authentication failed. Run `claude /login` or configure ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.";
  }
  return detail || raw;
}

function hasEntries(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function shellList(values = []) {
  return values.filter(Boolean).join(" ");
}

function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return JSON.stringify(value);
}

function codexMcpConfigArgs(mcpServers = {}) {
  const args = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const prefix = `mcp_servers.${name}`;
    if (cfg.command) {
      args.push("--config", `${prefix}.command=${tomlValue(cfg.command)}`);
      if (Array.isArray(cfg.args) && cfg.args.length) args.push("--config", `${prefix}.args=${tomlValue(cfg.args)}`);
      if (cfg.env && typeof cfg.env === "object") {
        for (const [key, value] of Object.entries(cfg.env)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            args.push("--config", `${prefix}.env.${key}=${tomlValue(String(value))}`);
          }
        }
      }
    } else if (cfg.url) {
      args.push("--config", `${prefix}.url=${tomlValue(cfg.url)}`);
      const headers = cfg.headers || {};
      for (const [key, value] of Object.entries(headers)) {
        if (/^[A-Za-z0-9_-]+$/.test(key)) {
          args.push("--config", `${prefix}.http_headers.${key}=${tomlValue(String(value))}`);
        }
      }
    }
    args.push("--config", `${prefix}.enabled=true`);
    args.push("--config", `${prefix}.required=false`);
  }
  return args;
}

export function buildCliCommand({
  sdk,
  model,
  effort,
  cwd,
  schemaPath,
  systemPrompt,
  prompt,
  mcpConfigPath,
  mcpServers,
  allowedTools,
  disallowedTools,
  permissionMode,
  maxTurns,
  skillDirs,
}) {
  const normalizedEffort = effort
    ? normalizeReasoningEffortForModel({ sdk, model }, effort)
    : null;
  if (sdk === "claude-code") {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", JSON.stringify(WORKLAB_RESULT_JSON_SCHEMA),
      "--model", model,
      "--append-system-prompt", systemPrompt,
      "--no-session-persistence",
    ];
    if (normalizedEffort) args.push("--effort", normalizedEffort);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (Number.isFinite(Number(maxTurns)) && Number(maxTurns) > 0) args.push("--max-turns", String(Number(maxTurns)));
    if (Array.isArray(skillDirs) && skillDirs.length) {
      args.push("--add-dir", ...skillDirs);
    }
    if (Array.isArray(allowedTools) && allowedTools.length) {
      args.push("--tools", allowedTools.join(","));
    }
    const autoAllowed = [
      ...(Array.isArray(allowedTools) ? allowedTools : []),
      ...Object.keys(mcpServers || {}).map((name) => `mcp__${name}__*`),
    ];
    if (autoAllowed.length) args.push("--allowedTools", shellList(autoAllowed));
    if (Array.isArray(disallowedTools) && disallowedTools.length) {
      args.push("--disallowedTools", shellList(disallowedTools));
    }
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
    args.push("--", prompt);
    return { command: "claude", args, cwd };
  }

  const args = [
    "exec",
    "--json",
    "--output-schema", schemaPath,
    "--model", model,
    "--cd", cwd,
    "--ephemeral",
    "--skip-git-repo-check",
    "--config", `service_tier=${tomlValue("fast")}`,
    "--config", "features.fast_mode=true",
  ];
  if (permissionMode === "bypassPermissions") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (permissionMode === "acceptEdits" || permissionMode === "auto") args.push("--full-auto");
  else if (permissionMode === "plan") args.push("--sandbox", "read-only");
  if (normalizedEffort) args.push("--config", `model_reasoning_effort=${normalizedEffort}`);
  if (normalizedEffort !== "none") args.push("--config", `model_reasoning_summary=${tomlValue("auto")}`);
  if (hasEntries(mcpServers)) args.push(...codexMcpConfigArgs(mcpServers));
  args.push([systemPrompt, prompt].filter((part) => String(part || "").trim()).join("\n\n"));
  return { command: "codex", args, cwd };
}

export async function generateCliResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model;
  const prompt = promptFromMessages(options.messages);
  const dir = mkdtempSync(join(tmpdir(), "worklab-cli-"));
  const schemaPath = join(dir, "worklab-result.schema.json");
  writeFileSync(schemaPath, JSON.stringify(WORKLAB_RESULT_JSON_SCHEMA));
  const mcpServers = options.mcpServers || {};
  const mcpConfigPath = hasEntries(mcpServers) && resolved.sdk === "claude-code"
    ? join(dir, "mcp.json")
    : null;
  if (mcpConfigPath) writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
  const commandSpec = buildCliCommand({
    sdk: resolved.sdk,
    model: resolved.model,
    effort: options.effort,
    cwd: options.cwd || process.cwd(),
    schemaPath,
    systemPrompt,
    prompt,
    mcpConfigPath,
    mcpServers,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    skillDirs: getSkillAccessDirs(options.skills || []),
  });

  const events = [];
  const texts = [];
  let errorMessage = null;
  let failureKind = null;
  let worklabResult = null;
  let structuredResultSource = null;
  let usage = {};
  const cliEventContext = {
    cwd: commandSpec.cwd,
    fileChangeSnapshots: new Map(),
  };

  try {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: { ...process.env, WORKLAB_WORKSPACE: commandSpec.cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        const ev = { type: "cli_stdout", text: line };
        events.push(ev);
        options.onEvent?.(ev);
        return;
      }
      const ev = normalizeCliEvent(raw, cliEventContext);
      if (ev) {
        events.push(ev);
        options.onEvent?.(ev);
      }
      for (const candidate of ev ? [raw, ev] : [raw]) {
        const structured = extractWorklabResult(candidate);
        if (structured.ok) {
          worklabResult = structured.result;
          structuredResultSource = inferStructuredResultSource(raw);
        }
      }
      if (ev?.type !== "worklab_result_candidate" && !isCodexReasoningEvent(raw)) {
        const text = textFromEvent(raw);
        pushUniqueText(texts, text);
      }
      if (raw.usage) usage = raw.usage;
      if (raw.type === "error") {
        const rawError = raw.message || raw.error || "cli error";
        errorMessage = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
        failureKind = "provider_unavailable";
      }
      const resultError = resultEventError(raw, commandSpec.command);
      if (resultError) {
        errorMessage = resultError.message;
        failureKind = resultError.failureKind;
      }
    });

    if (options.abortSignal) {
      const abort = () => child.kill("SIGTERM");
      if (options.abortSignal.aborted) abort();
      else options.abortSignal.addEventListener("abort", abort, { once: true });
    }

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    const stderrText = stderr.join("").trim();
    if (exitCode !== 0 && !errorMessage) errorMessage = stderrText || `${commandSpec.command} exited ${exitCode}`;
    const text = finalTextFromCliOutput(worklabResult, texts);
    if (exitCode === 0 && !errorMessage && !text.trim() && !worklabResult) {
      errorMessage = `${commandSpec.command} completed without final output`;
    }
    return {
      text,
      worklabResult,
      structuredResultSource,
      events,
      usage,
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: `${resolved.sdk}:${resolved.model}`,
      effort: options.effort || null,
      sdk: resolved.sdk,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage ? formatCliError(errorMessage, commandSpec.command) : null,
      failureKind,
    };
  } catch (err) {
    return {
      text: finalTextFromCliOutput(worklabResult, texts) || null,
      worklabResult,
      structuredResultSource,
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: resolved?.reference || null,
      effort: options.effort || null,
      sdk: resolved?.sdk || "cli",
      cancelled: !!options.abortSignal?.aborted,
      error: err.message || String(err),
      failureKind: failureKind || "provider_unavailable",
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
