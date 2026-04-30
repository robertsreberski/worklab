import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { normalizeReasoningEffortForModel } from "../../core/ai.js";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  extractWorklabResult,
  formatWorklabResultText,
  stripWorklabResultJson,
} from "../result/contract.js";
import { normalizeCodexItemEvent } from "../streaming/codex-events.js";
import { createFileChangePayload } from "../file-change-stats.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import { estimateCost } from "../cost.js";
import { backendCapabilities } from "../backend.js";

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n")
    : String(messages || "");
}

function pushUniqueText(texts, text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return;
  if (texts.some((existing) => existing.trim() === value)) return;
  texts.push(value);
}

function finalTextFromOutput(worklabResult, texts) {
  const delivered = stripWorklabResultJson(texts[texts.length - 1] || "");
  return delivered || formatWorklabResultText(worklabResult);
}

function userTextInput(text) {
  return [{ type: "text", text: String(text || ""), text_elements: [] }];
}

function sandboxForPermissionMode(permissionMode) {
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  if (permissionMode === "plan") return "read-only";
  return "workspace-write";
}

function approvalPolicyForPermissionMode(permissionMode) {
  if (permissionMode === "bypassPermissions") return "never";
  if (permissionMode === "plan") return "on-request";
  return "on-failure";
}

function codexMcpConfig(mcpServers = {}) {
  const servers = {};
  for (const [name, cfg] of Object.entries(mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    if (cfg?.command) {
      servers[name] = {
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
        ...(cfg.env && typeof cfg.env === "object" ? { env: cfg.env } : {}),
        enabled: true,
        required: false,
      };
    } else if (cfg?.url) {
      servers[name] = {
        url: cfg.url,
        ...(cfg.headers && typeof cfg.headers === "object" ? { http_headers: cfg.headers } : {}),
        enabled: true,
        required: false,
      };
    }
  }
  return servers;
}

function codexErrorMessage(error) {
  if (!error) return "Codex app-server error";
  if (typeof error === "string") return error;
  const data = error.data || error.error || {};
  const info = data.info || data.code || error.code;
  if (info && typeof info === "object" && "activeTurnNotSteerable" in info) {
    return "Codex active turn is not steerable";
  }
  return error.message || data.message || JSON.stringify(error);
}

function isActiveTurnNotSteerable(error) {
  const info = error?.data?.info || error?.data?.error?.info || error?.info;
  return info === "activeTurnNotSteerable" || Boolean(info?.activeTurnNotSteerable);
}

function isNoActiveTurnToSteer(error) {
  return /no active turn to steer/i.test(codexErrorMessage(error));
}

export function createCodexAppServerClient({
  command = process.env.WORKLAB_CODEX_APP_SERVER_COMMAND || "codex",
  args = process.env.WORKLAB_CODEX_APP_SERVER_COMMAND
    ? []
    : ["app-server", "--listen", "stdio://"],
  cwd,
  env = {},
  onNotification = () => {},
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  function rejectAll(err) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  }

  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      onNotification({ method: "warning", params: { message: `Malformed Codex app-server output: ${line}` } });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(codexErrorMessage(message.error)), { responseError: message.error }));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) onNotification(message);
  });

  child.on("error", (err) => {
    closed = true;
    rejectAll(err);
    resolveClosed(err);
  });
  child.on("close", (code) => {
    closed = true;
    const detail = stderr.join("").trim();
    const err = new Error(detail || `codex app-server exited ${code}`);
    rejectAll(err);
    resolveClosed(err);
  });

  function request(method, params, { timeoutMs = 30_000 } = {}) {
    if (closed || child.stdin?.destroyed || child.stdin?.writableEnded) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    try { child.stdin?.end?.(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
    rejectAll(new Error("codex app-server closed"));
  }

  return { request, close, child, closed: closedPromise };
}

function mapThreadItem(method, item) {
  if (!item || typeof item !== "object") return null;
  const type = method.endsWith("started") ? "item.started" : "item.completed";
  if (item.type === "agentMessage") {
    return { type, item: { type: "agent_message", id: item.id, text: item.text || "" } };
  }
  if (item.type === "commandExecution") {
    return {
      type,
      item: {
        type: "command_execution",
        id: item.id,
        command: item.command,
        aggregated_output: item.aggregatedOutput || "",
        exit_code: item.exitCode,
        status: item.status,
      },
    };
  }
  if (item.type === "fileChange") {
    return {
      type,
      item: {
        type: "file_change",
        id: item.id,
        changes: item.changes || [],
        status: item.status,
      },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      type,
      item: {
        type: "mcp_tool_call",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      },
    };
  }
  if (item.type === "reasoning") {
    const text = [...(item.summary || []), ...(item.content || [])].join("\n").trim();
    return text ? { type: "assistant", message: { content: [{ type: "thinking", text }] } } : null;
  }
  return null;
}

function usageFromTokenUsage(tokenUsage) {
  const last = tokenUsage?.last || tokenUsage?.total || {};
  return {
    input_tokens: last.inputTokens ?? null,
    output_tokens: last.outputTokens ?? null,
    cache_read_tokens: last.cachedInputTokens ?? null,
  };
}

export async function generateCodexAppResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model;
  const prompt = promptFromMessages(options.messages);
  const normalizedEffort = options.effort
    ? normalizeReasoningEffortForModel(resolved, options.effort)
    : null;
  const events = [];
  const texts = [];
  const agentTextByItem = new Map();
  let threadId = null;
  let activeTurnId = null;
  let turnCompleted = false;
  let errorMessage = null;
  let failureKind = null;
  let usage = {};
  let worklabResult = null;
  let structuredResultSource = null;
  let resolveTurn;
  let resolveTurnReady;
  let turnReadyResolved = false;
  const fileChangeSnapshots = new Map();
  const codexItemContext = {
    fileChangePayload: (raw) => createFileChangePayload(raw, {
      cwd: options.cwd || process.cwd(),
      snapshots: fileChangeSnapshots,
    }),
  };
  const turnDone = new Promise((resolve) => { resolveTurn = resolve; });
  const turnReady = new Promise((resolve) => { resolveTurnReady = resolve; });

  function setActiveTurnId(turnId, { steerReady = false } = {}) {
    activeTurnId = turnId || activeTurnId;
    if (steerReady && !turnReadyResolved && threadId && activeTurnId) {
      turnReadyResolved = true;
      resolveTurnReady();
    }
  }

  function emitEvent(event) {
    if (!event) return;
    events.push(event);
    options.onEvent?.(event);
  }

  function handleAgentText(text, source = "agent_message") {
    pushUniqueText(texts, text);
    const structured = extractWorklabResult({ type: source, text });
    if (structured.ok) {
      worklabResult = structured.result;
      structuredResultSource = source;
      emitEvent({
        type: "worklab_result_candidate",
        source,
        text,
        worklab_result: structured.result,
      });
      return;
    }
    emitEvent({ type: "assistant", message: { content: [{ type: "text", text }] } });
  }

  const client = createCodexAppServerClient({
    command: options.codexAppServerCommand,
    args: options.codexAppServerArgs,
    cwd: options.cwd,
    env: options.codexAppServerEnv,
    onNotification: (notification) => {
      const { method, params = {} } = notification;
      if (method === "turn/started") {
        setActiveTurnId(params.turn?.id, { steerReady: true });
        emitEvent({ type: "cli_event", raw: { type: "turn_started", turn: params.turn } });
        return;
      }
      if (method === "turn/completed") {
        setActiveTurnId(params.turn?.id);
        turnCompleted = true;
        if (params.turn?.status === "failed") {
          errorMessage = params.turn?.error?.message || params.turn?.error || "Codex turn failed";
          failureKind = "provider_unavailable";
        }
        emitEvent({ type: "cli_event", raw: { type: "turn_completed", turn: params.turn } });
        resolveTurn(params.turn);
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        usage = usageFromTokenUsage(params.tokenUsage);
        return;
      }
      if (method === "item/agentMessage/delta") {
        const current = agentTextByItem.get(params.itemId) || "";
        agentTextByItem.set(params.itemId, `${current}${params.delta || ""}`);
        return;
      }
      if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
        emitEvent({ type: "assistant", message: { content: [{ type: "thinking", text: params.delta || "" }] } });
        return;
      }
      if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
        emitEvent({
          type: "runtime_warning",
          warning_kind: method.replace(/\W+/g, "_"),
          message: params.message || params.error || JSON.stringify(params),
        });
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        const raw = mapThreadItem(method, params.item);
        if (params.item?.type === "agentMessage") {
          const text = params.item.text || agentTextByItem.get(params.item.id) || "";
          if (method === "item/completed") handleAgentText(text);
          return;
        }
        if (raw) emitEvent(normalizeCodexItemEvent(raw, codexItemContext) || raw);
      }
    },
  });
  const abortHandler = () => {
    if (threadId && activeTurnId) {
      client.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
    client.close();
  };

  async function steerLiveInput() {
    if (!options.liveInput) return;
    for await (const message of options.liveInput) {
      if (turnCompleted) break;
      if (!threadId || !activeTurnId || !turnReadyResolved) {
        await Promise.race([
          turnReady,
          turnDone,
          client.closed.then((err) => { throw err; }),
        ]);
        if (turnCompleted || !turnReadyResolved) break;
      }
      const input = userTextInput(formatLiveInputGuidance(message.body));
      try {
        const response = await client.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurnId,
          input,
        });
        activeTurnId = response?.turnId || activeTurnId;
      } catch (err) {
        const providerError = err?.responseError;
        if (isNoActiveTurnToSteer(providerError || err)) {
          await Promise.race([
            turnReady,
            turnDone,
            client.closed.then((closedErr) => { throw closedErr; }),
          ]);
          if (turnCompleted) break;
          try {
            const response = await client.request("turn/steer", {
              threadId,
              expectedTurnId: activeTurnId,
              input,
            });
            activeTurnId = response?.turnId || activeTurnId;
            continue;
          } catch (retryErr) {
            const retryProviderError = retryErr?.responseError;
            emitEvent({
              type: "runtime_warning",
              warning_kind: isActiveTurnNotSteerable(retryProviderError) ? "active_turn_not_steerable" : "live_input_rejected",
              message: codexErrorMessage(retryProviderError || retryErr),
            });
            continue;
          }
        }
        emitEvent({
          type: "runtime_warning",
          warning_kind: isActiveTurnNotSteerable(providerError) ? "active_turn_not_steerable" : "live_input_rejected",
          message: codexErrorMessage(providerError || err),
        });
      }
    }
  }

  try {
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortHandler();
      else options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    await client.request("initialize", {
      clientInfo: { name: "worklab", title: "Worklab", version: "0" },
      capabilities: { experimentalApi: true },
    });
    const mcpServers = codexMcpConfig(options.mcpServers);
    const config = {
      service_tier: "fast",
      features: { fast_mode: true },
      ...(Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {}),
    };
    if (normalizedEffort) {
      config.model_reasoning_effort = normalizedEffort;
      if (normalizedEffort !== "none") config.model_reasoning_summary = "auto";
    }
    const thread = await client.request("thread/start", {
      model: resolved.model,
      modelProvider: "openai",
      serviceTier: "fast",
      cwd: options.cwd || process.cwd(),
      approvalPolicy: approvalPolicyForPermissionMode(options.permissionMode),
      sandbox: sandboxForPermissionMode(options.permissionMode),
      config,
      serviceName: "worklab",
      developerInstructions: systemPrompt,
      ephemeral: true,
      sessionStartSource: "startup",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    threadId = thread?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");

    const steerTask = steerLiveInput();
    steerTask.catch((err) => {
      emitEvent({
        type: "runtime_warning",
        warning_kind: "live_input_failed",
        message: err?.message || String(err),
      });
    });
    const turn = await client.request("turn/start", {
      threadId,
      input: userTextInput(prompt),
      cwd: options.cwd || process.cwd(),
      approvalPolicy: approvalPolicyForPermissionMode(options.permissionMode),
      sandboxPolicy: options.permissionMode === "bypassPermissions" ? { type: "dangerFullAccess" } : null,
      model: resolved.model,
      serviceTier: "fast",
      effort: normalizedEffort,
      summary: normalizedEffort && normalizedEffort !== "none" ? "auto" : "none",
      outputSchema: WORKLAB_RESULT_JSON_SCHEMA,
    });
    setActiveTurnId(turn?.turn?.id);

    let prematureClose = false;
    try {
      await Promise.race([
        turnDone,
        client.closed.then((err) => {
          if (!turnCompleted) {
            prematureClose = true;
            throw err;
          }
          return null;
        }),
      ]);
    } catch (err) {
      if (prematureClose && !errorMessage) {
        errorMessage = err?.message || "codex app-server stream closed before turn completed";
        failureKind = "provider_unavailable";
      } else if (!prematureClose) {
        throw err;
      }
    }
    turnCompleted = true;
    await Promise.race([steerTask, Promise.resolve()]);

    const text = finalTextFromOutput(worklabResult, texts);
    let codexErrorCode = prematureClose ? "codex_app_server_closed" : null;
    if (!errorMessage && !text.trim() && !worklabResult) {
      errorMessage = "codex app-server completed without final output";
      failureKind = "provider_unavailable";
      codexErrorCode = codexErrorCode || "codex_app_server_no_output";
    }
    const hadPartialProgress = events.length > 0 || texts.length > 0;
    const reference = `codex:${resolved.model}`;
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? usage?.cachedInputTokens ?? 0;
    const costUsd = estimateCost({
      db: options.db,
      model: reference,
      inputTokens,
      outputTokens,
      cachedTokens,
    });
    const enrichedUsage = {
      ...usage,
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      cache_read_tokens: cachedTokens || null,
      cost_usd: costUsd,
    };
    return {
      text,
      worklabResult,
      structuredResultSource,
      events,
      usage: enrichedUsage,
      durationMs: Date.now() - start,
      numTurns: 1,
      model: reference,
      effort: options.effort || null,
      sdk: "codex",
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind,
      diagnostics: {
        ...(codexErrorCode ? { pi_error_code: codexErrorCode } : {}),
        ...(hadPartialProgress && failureKind === "provider_unavailable"
          ? { had_partial_progress: true }
          : {}),
      },
    };
  } catch (err) {
    return {
      text: finalTextFromOutput(worklabResult, texts) || null,
      worklabResult,
      structuredResultSource,
      events,
      usage,
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: resolved?.reference || `codex:${resolved?.model || ""}`,
      effort: options.effort || null,
      sdk: "codex",
      cancelled: !!options.abortSignal?.aborted,
      error: err?.message || String(err),
      failureKind: failureKind || "provider_unavailable",
      diagnostics: {
        ...(err?.code ? { pi_error_code: String(err.code) } : {}),
        ...(events.length > 0 || texts.length > 0 ? { had_partial_progress: true } : {}),
      },
    };
  } finally {
    options.abortSignal?.removeEventListener?.("abort", abortHandler);
    client.close();
  }
}

export const codexAppBackend = {
  kind: "codex",
  capabilities: backendCapabilities("codex"),
  execute: generateCodexAppResponse,
};
