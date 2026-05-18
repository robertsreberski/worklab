import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getSkillAccessDirs } from "../../agent/prompt/skill-index.js";
import { normalizeCodexItemEvent } from "../streaming/codex-events.js";
import { createFileChangePayload } from "../file-change-stats.js";
import { estimateCost } from "../cost.js";
import { createStderrTail } from "../failure.js";
import { modelWithContextWindow } from "../runtime/context-windows.js";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";
import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";
import {
  claudeNativeAgentDefinitions,
  claudeToolsWithNativeSubagents,
} from "./claude-subagents.js";

const DORMANT_CLI_CAPABILITIES = {
  streaming: true,
  structured_output: true,
  // intelligence-ramp Phase 5.1: claude-cli supports resume via `--resume` and
  // surfaces session_id from init/result events; the bridge wraps the env-var
  // hand-off the coordinator already populates on continuations.
  supports_session_resume: true,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
};

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

const ANTHROPIC_STREAM_EVENT_TYPES = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
]);

// Claude Code CLI emits one `assistant` event per finalised content block in
// stream-json mode, but for `thinking` blocks the text is only ever sent via
// `thinking_delta` chunks under `--include-partial-messages`. The finalised
// block carries the signature but `thinking: ""`. The buffer accumulates the
// streamed thinking deltas and splices them back into the finalised assistant
// event before it is forwarded to the host.
export function createThinkingBuffer() {
  let currentMessageId = null;
  const byMessage = new Map();

  function unwrap(raw) {
    return raw?.type === "stream_event" && raw.event ? raw.event : raw;
  }

  function isStreamShape(raw) {
    if (!raw || typeof raw !== "object") return false;
    if (raw.type === "stream_event") return true;
    return ANTHROPIC_STREAM_EVENT_TYPES.has(raw.type);
  }

  function bufferFor(messageId) {
    if (!messageId) return null;
    let bucket = byMessage.get(messageId);
    if (!bucket) {
      bucket = new Map();
      byMessage.set(messageId, bucket);
    }
    return bucket;
  }

  function onStreamEvent(raw) {
    const inner = unwrap(raw);
    if (!inner || typeof inner !== "object") return;

    if (inner.type === "message_start") {
      currentMessageId = inner.message?.id || null;
      // Defensive: drop any stale state if the same id reappears.
      if (currentMessageId) byMessage.delete(currentMessageId);
      return;
    }

    if (inner.type === "content_block_start") {
      if (inner.content_block?.type !== "thinking") return;
      const bucket = bufferFor(currentMessageId);
      if (bucket) bucket.set(inner.index, { text: "", consumed: false });
      return;
    }

    if (inner.type === "content_block_delta") {
      const bucket = bufferFor(currentMessageId);
      if (!bucket) return;
      const entry = bucket.get(inner.index);
      if (!entry) return;
      if (inner.delta?.type === "thinking_delta" && typeof inner.delta.thinking === "string") {
        entry.text += inner.delta.thinking;
      }
      // signature_delta is ignored: the signature already lands on the
      // finalised assistant event we will rehydrate.
    }
  }

  function rehydrate(assistantRaw) {
    if (!assistantRaw || typeof assistantRaw !== "object") return assistantRaw;
    const messageId = assistantRaw.message?.id;
    const content = assistantRaw.message?.content;
    if (!messageId || !Array.isArray(content)) return assistantRaw;
    const bucket = byMessage.get(messageId);
    if (!bucket || bucket.size === 0) return assistantRaw;

    const pending = [...bucket.entries()]
      .filter(([, entry]) => !entry.consumed && entry.text)
      .sort(([a], [b]) => (Number(a) || 0) - (Number(b) || 0));
    if (pending.length === 0) return assistantRaw;

    let mutated = null;
    let cursor = 0;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block || block.type !== "thinking" || block.thinking) continue;
      if (cursor >= pending.length) break;
      const [, entry] = pending[cursor++];
      entry.consumed = true;
      if (!mutated) {
        mutated = { ...assistantRaw, message: { ...assistantRaw.message, content: [...content] } };
      }
      mutated.message.content[i] = { ...block, thinking: entry.text };
    }
    return mutated || assistantRaw;
  }

  return { isStreamShape, onStreamEvent, rehydrate };
}

export function normalizeCliEvent(raw, context = {}) {
  if (!raw || typeof raw !== "object") return { type: "cli_event", raw };
  const thinkingBuffer = context.thinkingBuffer;
  if (thinkingBuffer && thinkingBuffer.isStreamShape(raw)) {
    thinkingBuffer.onStreamEvent(raw);
    return null;
  }
  if (CODEX_RAW_REASONING_EVENT_TYPES.has(raw.type)) return null;
  if (CODEX_REASONING_EVENT_TYPES.has(raw.type) || (CODEX_REASONING_ITEM_EVENTS.has(raw.type) && raw.item?.type === "reasoning")) {
    const text = codexReasoningSummaryText(raw).trim();
    return text
      ? { type: "assistant", message: { content: [{ type: "thinking", text }] } }
      : null;
  }
  if (raw.type === "assistant") {
    return thinkingBuffer ? thinkingBuffer.rehydrate(raw) : raw;
  }
  if (raw.type === "user" || raw.type === "result" || raw.type === "error") return raw;
  if (raw.type === "message" && raw.message) return { type: "assistant", message: raw.message };
  if (raw.type === "item.completed" && raw.item?.type === "agent_message" && typeof raw.item.text === "string") {
    return { type: "assistant", message: { content: [{ type: "text", text: raw.item.text }] } };
  }
  const codexItem = normalizeCodexItemEvent(raw, {
    fileChangePayload: (event) => createFileChangePayload(event, {
      cwd: context.cwd || process.cwd(),
      snapshots: context.fileChangeSnapshots || new Map(),
    }),
  });
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
      if (cfg.cwd && typeof cfg.cwd === "string") args.push("--config", `${prefix}.cwd=${tomlValue(cfg.cwd)}`);
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
  outputSchema,
  systemPrompt,
  prompt,
  mcpConfigPath,
  mcpServers,
  allowedTools,
  disallowedTools,
  permissionMode,
  maxTurns,
  skillDirs,
  resumeSessionId,
  nativeSubagents,
  contextWindow,
}) {
  // Effort is expected to be pre-normalized by core/ai.js#generateResponse
  // before reaching this provider. Direct callers of buildCliCommand must
  // pass an already-normalized reasoning level (low/medium/high/xhigh/none).
  const normalizedEffort = typeof effort === "string" && effort.trim() ? effort : null;
  if (sdk === "claude-code") {
    const nativeAgents = claudeNativeAgentDefinitions(nativeSubagents);
    const cliAllowedTools = claudeToolsWithNativeSubagents(allowedTools, nativeSubagents);
    // intelligence-ramp Phase 5.1: when the coordinator hands us a parent
    // session id (recovery continuation, R12), pass --resume so the host
    // CLI can keep its own conversation cache warm. Otherwise stay
    // ephemeral so unrelated runs never bleed into each other.
    const resumeFlag = typeof resumeSessionId === "string" && resumeSessionId.trim().length > 0
      ? ["--resume", resumeSessionId.trim()]
      : ["--no-session-persistence"];
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      ...(outputSchema ? ["--json-schema", JSON.stringify(outputSchema)] : []),
      "--model", modelWithContextWindow(model, contextWindow),
      "--append-system-prompt", systemPrompt,
      ...resumeFlag,
    ];
    if (normalizedEffort) args.push("--effort", normalizedEffort);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (Number.isFinite(Number(maxTurns)) && Number(maxTurns) > 0) args.push("--max-turns", String(Number(maxTurns)));
    if (Array.isArray(skillDirs) && skillDirs.length) {
      args.push("--add-dir", ...skillDirs);
    }
    if (nativeAgents) args.push("--agents", JSON.stringify(nativeAgents));
    if (Array.isArray(cliAllowedTools) && cliAllowedTools.length) {
      args.push("--tools", cliAllowedTools.join(","));
    }
    const autoAllowed = [
      ...(Array.isArray(cliAllowedTools) ? cliAllowedTools : []),
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
    ...(schemaPath ? ["--output-schema", schemaPath] : []),
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
  const dir = mkdtempSync(join(tmpdir(), readRuntimeBrand().tempdirPrefix));
  const schemaPath = options.outputSchema ? join(dir, "output-schema.json") : null;
  if (schemaPath) writeFileSync(schemaPath, JSON.stringify(options.outputSchema));
  const mcpServers = options.mcpServers || {};
  const mcpConfigPath = hasEntries(mcpServers) && resolved.sdk === "claude-code"
    ? join(dir, "mcp.json")
    : null;
  if (mcpConfigPath) writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
  const reusableSessionId = (typeof options.sessionId === "string" && options.sessionId.trim())
    || (typeof options.providerSessionId === "string" && options.providerSessionId.trim())
    || null;
  let providerSessionId = reusableSessionId || null;
  const commandSpec = buildCliCommand({
    sdk: resolved.sdk,
    model: resolved.model,
    effort: options.effort,
    cwd: options.cwd || process.cwd(),
    schemaPath,
    outputSchema: options.outputSchema,
    systemPrompt,
    prompt,
    mcpConfigPath,
    mcpServers,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    skillDirs: Array.isArray(options.skillDirs)
      ? options.skillDirs
      : getSkillAccessDirs(options.skills || []),
    resumeSessionId: reusableSessionId,
    nativeSubagents: options.nativeSubagents,
    contextWindow: options.contextWindow,
  });

  const events = [];
  const texts = [];
  let errorMessage = null;
  let failureKind = null;
  let usage = {};
  // Claude Code returns structured output via a `StructuredOutput` tool_use
  // block. We capture the latest one we see during the run; if `outputSchema`
  // was supplied the bridge surfaces it as `structuredResult` so the host's
  // result parser can validate it without re-walking the event stream.
  let structuredResult;
  function captureStructuredOutputFromRaw(raw) {
    const blocks = raw?.message?.content || raw?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block?.type === "tool_use" && block?.name === "StructuredOutput" && block?.input !== undefined) {
        structuredResult = block.input;
      }
    }
  }
  const cliEventContext = {
    cwd: commandSpec.cwd,
    fileChangeSnapshots: new Map(),
    thinkingBuffer: createThinkingBuffer(),
  };

  const stderrTail = createStderrTail({ limit: 8 * 1024 });
  try {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk) => stderrTail.push(chunk));

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
      if (!isCodexReasoningEvent(raw)) {
        const text = textFromEvent(raw);
        pushUniqueText(texts, text);
      }
      captureStructuredOutputFromRaw(raw);
      if (raw.usage) usage = raw.usage;
      // intelligence-ramp Phase 5.1: capture session_id from CLI events so the
      // coordinator can chain it on the next continuation. Claude Code emits
      // session_id on the init system message and again on the result event.
      const candidateSessionId = raw.session_id ?? raw.sessionId ?? raw.thread_id ?? null;
      if (typeof candidateSessionId === "string" && candidateSessionId.trim().length > 0) {
        providerSessionId = candidateSessionId.trim();
      }
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
    const stderrText = stderrTail.toString().trim();
    let cliErrorCode = null;
    if (exitCode !== 0 && !errorMessage) errorMessage = stderrText || `${commandSpec.command} exited ${exitCode}`;
    const text = texts[texts.length - 1] || "";
    const hadPartialProgress = events.length > 0 || texts.length > 0;
    if (exitCode === 0 && !errorMessage && !text.trim() && structuredResult === undefined) {
      errorMessage = `${commandSpec.command} completed without final output`;
      failureKind = failureKind || "provider_unavailable";
      cliErrorCode = "cli_stream_terminated";
    }
    const reference = `${resolved.sdk}:${resolved.model}`;
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? usage?.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage?.cache_creation_tokens ?? usage?.cache_creation_input_tokens ?? 0;
    const costUsd = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: cacheCreationTokens,
    });
    const enrichedUsage = {
      ...usage,
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      cache_read_tokens: cachedTokens || null,
      cache_creation_tokens: cacheCreationTokens || null,
      cost_usd: costUsd,
    };
    return {
      text,
      structuredResult,
      structuredResultSource: structuredResult === undefined ? null : "StructuredOutput",
      events,
      usage: enrichedUsage,
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: reference,
      effort: options.effort || null,
      sdk: resolved.sdk,
      providerSessionId: providerSessionId || null,
      provider_session_id: providerSessionId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage ? formatCliError(errorMessage, commandSpec.command) : null,
      failureKind,
      stderrTail: stderrText || null,
      diagnostics: {
        ...(cliErrorCode ? { pi_error_code: cliErrorCode } : {}),
        ...(hadPartialProgress && failureKind === "provider_unavailable"
          ? { had_partial_progress: true }
          : {}),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: (cachedTokens || 0) > 0 || (cacheCreationTokens || 0) > 0,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: null,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } catch (err) {
    return {
      text: texts[texts.length - 1] || null,
      structuredResult,
      structuredResultSource: structuredResult === undefined ? null : "StructuredOutput",
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: resolved?.reference || null,
      effort: options.effort || null,
      sdk: resolved?.sdk || "cli",
      providerSessionId: providerSessionId || null,
      provider_session_id: providerSessionId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: err.message || String(err),
      failureKind: failureKind || "provider_unavailable",
      stderrTail: stderrTail.toString() || null,
      diagnostics: {
        ...(err?.code ? { pi_error_code: String(err.code) } : {}),
        ...(events.length > 0 || texts.length > 0 ? { had_partial_progress: true } : {}),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: null,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: null,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export const claudeCodeBackend = {
  kind: "claude-code",
  capabilities: { kind: "claude-code", runtime: "cli", ...DORMANT_CLI_CAPABILITIES },
  execute: generateCliResponse,
};

export const codexCliBackend = {
  kind: "codex-cli",
  capabilities: { kind: "codex-cli", runtime: "cli", ...DORMANT_CLI_CAPABILITIES },
  execute: generateCliResponse,
};

// CLI bridge for sdk='claude' agents that opt into execution_mode='cli'.
// generateCliResponse internally branches on resolved.sdk; the SDK shape
// from parseModelReference uses 'claude', the CLI builder expects
// 'claude-code', so we shim the model ref here rather than scattering
// translation logic across the registry.
export const claudeCodeRuntimeBridge = {
  id: "claude-code",
  kind: "claude-code",
  capabilities: { kind: "claude-code", runtime: "cli", ...DORMANT_CLI_CAPABILITIES },
  supports: (ref, options) => ref?.sdk === "claude" && options?.executionMode === "cli",
  execute: (systemPrompt, options) => generateCliResponse(systemPrompt, {
    ...options,
    model: { ...options.model, sdk: "claude-code" },
  }),
};
