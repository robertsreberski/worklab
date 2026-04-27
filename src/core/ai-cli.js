import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { normalizeReasoningEffortForModel } from "./ai.js";
import { getSkillAccessDirs } from "./skills.js";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  extractWorklabResult,
  formatWorklabResultText,
  parseStandaloneWorklabResultText,
} from "./worklab-result.js";

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n")
    : String(messages || "");
}

function normalizeCliEvent(raw) {
  if (!raw || typeof raw !== "object") return { type: "cli_event", raw };
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
  if ((raw.type === "item.started" || raw.type === "item.completed") && raw.item?.type === "mcp_tool_call") {
    const item = raw.item;
    const id = item.id || `${item.server || "mcp"}:${item.tool || "tool"}`;
    const name = item.server && item.tool ? `mcp__${item.server}__${item.tool}` : item.tool || "mcp_tool_call";
    if (raw.type === "item.started") {
      return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: item.arguments || {} }] } };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: id,
          content: item.error || item.result?.content || item.result || "",
          is_error: !!item.error,
        }],
      },
    };
  }
  if ((raw.type === "item.started" || raw.type === "item.completed") && raw.item?.type === "command_execution") {
    const item = raw.item;
    const id = item.id || item.command || "command_execution";
    if (raw.type === "item.started") {
      return { type: "assistant", message: { content: [{ type: "tool_use", id, name: "command_execution", input: { command: item.command } }] } };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: id,
          content: item.aggregated_output || "",
          is_error: typeof item.exit_code === "number" && item.exit_code !== 0,
        }],
      },
    };
  }
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

function pushUniqueText(texts, text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return;
  if (texts.some((existing) => existing.trim() === value)) return;
  texts.push(value);
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
  let worklabResult = null;
  let structuredResultSource = null;
  let usage = {};

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
      const ev = normalizeCliEvent(raw);
      events.push(ev);
      options.onEvent?.(ev);
      for (const candidate of [raw, ev]) {
        const structured = extractWorklabResult(candidate);
        if (structured.ok) {
          worklabResult = structured.result;
          structuredResultSource = inferStructuredResultSource(raw);
        }
      }
      if (ev?.type !== "worklab_result_candidate") {
        const text = textFromEvent(raw);
        pushUniqueText(texts, text);
      }
      if (raw.usage) usage = raw.usage;
      if (raw.type === "error") {
        const rawError = raw.message || raw.error || "cli error";
        errorMessage = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
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
    const text = formatWorklabResultText(worklabResult) || texts.join("\n\n");
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
    };
  } catch (err) {
    return {
      text: formatWorklabResultText(worklabResult) || texts.join("\n\n") || null,
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
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
