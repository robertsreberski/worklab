import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { normalizeCodexItemEvent } from "../streaming/codex-events.js";
import { createFileChangePayload } from "../file-change-stats.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import { estimateCost } from "../cost.js";
import { codexModelSupportsFastMode, normalizeFastMode } from "../runtime/fast-mode.js";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";
import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_THREAD_START_ATTEMPTS = 2;
const DEFAULT_THREAD_START_BACKOFF_MS = 5_000;
const MIN_THREAD_START_TIMEOUT_MS = 60_000;
const MAX_THREAD_START_TIMEOUT_MS = 180_000;
const THREAD_START_PROMPT_CHARS_PER_STEP = 50_000;
const THREAD_START_TIMEOUT_STEP_MS = 30_000;

const CODEX_APP_CAPABILITIES = {
  kind: "codex-app",
  runtime: "app-server",
  streaming: true,
  structured_output: true,
  // intelligence-ramp Phase 5.2: codex-app emits the started thread id, which
  // we surface as provider_session_id so the coordinator can hand it back to
  // the next continuation. The app-server itself always starts a fresh
  // thread today (no thread/load primitive in this protocol revision), so
  // the value primarily lets us correlate continuations in the run log.
  supports_session_resume: true,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
  supports_fast_mode: true,
};

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

function userTextInput(text) {
  return [{ type: "text", text: String(text || ""), text_elements: [] }];
}

function integerOption(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultThreadStartTimeoutMs(systemPrompt) {
  const promptChars = String(systemPrompt || "").length;
  const sizeSteps = Math.max(0, Math.ceil(promptChars / THREAD_START_PROMPT_CHARS_PER_STEP) - 1);
  return clamp(
    MIN_THREAD_START_TIMEOUT_MS + (sizeSteps * THREAD_START_TIMEOUT_STEP_MS),
    MIN_THREAD_START_TIMEOUT_MS,
    MAX_THREAD_START_TIMEOUT_MS,
  );
}

function threadStartPolicy(systemPrompt, options = {}) {
  return {
    timeoutMs: integerOption(
      options.codexThreadStartTimeoutMs,
      defaultThreadStartTimeoutMs(systemPrompt),
      { min: 1, max: Number.MAX_SAFE_INTEGER },
    ),
    attempts: integerOption(
      options.codexThreadStartAttempts,
      DEFAULT_THREAD_START_ATTEMPTS,
      { min: 1, max: 5 },
    ),
    backoffMs: integerOption(
      options.codexThreadStartBackoffMs,
      DEFAULT_THREAD_START_BACKOFF_MS,
      { min: 0, max: 300_000 },
    ),
  };
}

function delay(ms, signal) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
        ...(cfg.cwd && typeof cfg.cwd === "string" ? { cwd: cfg.cwd } : {}),
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

function isCodexRequestTimeout(error, method = null) {
  return error?.code === "CODEX_APP_SERVER_REQUEST_TIMEOUT"
    && (!method || error.method === method);
}

function codexErrorDiagnostics(error) {
  if (!error) return {};
  if (isCodexRequestTimeout(error)) {
    return {
      codex_error_code: "codex_app_server_request_timeout",
      codex_request_method: error.method || null,
      codex_request_timeout_ms: error.timeoutMs || null,
      ...(error.stderrTail ? { stderr_tail: error.stderrTail } : {}),
    };
  }
  return error.code ? { codex_error_code: String(error.code) } : {};
}

function withoutCodexRequestErrorDiagnostics(diagnostics) {
  const {
    codex_error_code: _codexErrorCode,
    codex_request_method: _codexRequestMethod,
    codex_request_timeout_ms: _codexRequestTimeoutMs,
    stderr_tail: _stderrTail,
    ...rest
  } = diagnostics || {};
  return rest;
}

function codexNativeTeammates(nativeSubagents) {
  if (nativeSubagents?.provider !== "codex" || !Array.isArray(nativeSubagents.teammates)) return [];
  return nativeSubagents.teammates.map((agent) => {
    const name = String(agent?.name || "").trim();
    if (!name) return null;
    return {
      name,
      displayName: agent.displayName || name,
      description: agent.description || "",
      model: agent.model?.model || agent.modelRef || null,
      reasoningEffort: agent.effort || null,
      instructions: agent.helperSystemPrompt || agent.instructions || "",
    };
  }).filter(Boolean);
}

function codexCollaborationModePayload(nativeSubagents, { model, effort, systemPrompt }) {
  const teammates = codexNativeTeammates(nativeSubagents);
  if (!teammates.length) return null;
  return {
    mode: "default",
    teammates,
    settings: {
      model,
      reasoningEffort: effort || null,
      developerInstructions: systemPrompt,
    },
  };
}

export function createCodexAppServerClient({
  command = "codex",
  args = ["app-server", "--listen", "stdio://"],
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

  function stderrTail() {
    const text = stderr.join("").trim();
    if (!text) return "";
    return text.length > 8_192 ? text.slice(text.length - 8_192) : text;
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

  function request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (closed || child.stdin?.destroyed || child.stdin?.writableEnded) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`codex app-server request timed out: ${method}`), {
          code: "CODEX_APP_SERVER_REQUEST_TIMEOUT",
          method,
          timeoutMs,
          stderrTail: stderrTail(),
        }));
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
  if (item.type === "collabAgentToolCall") {
    const name = `codex_${item.tool || "subagent"}`;
    if (method.endsWith("started")) {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: item.id,
            name,
            input: {
              prompt: item.prompt,
              model: item.model,
              reasoningEffort: item.reasoningEffort,
              receiverThreadIds: item.receiverThreadIds || [],
            },
          }],
        },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: item.id,
          content: {
            status: item.status,
            receiverThreadIds: item.receiverThreadIds || [],
            agentsStates: item.agentsStates || [],
            ...(item.error ? { error: item.error } : {}),
          },
          is_error: item.status === "failed" || Boolean(item.error),
        }],
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
  // Effort is expected to be pre-normalized by core/ai.js#generateResponse
  // before reaching this provider. We trust options.effort verbatim.
  const normalizedEffort = typeof options.effort === "string" && options.effort.trim()
    ? options.effort
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
  let codexDiagnostics = {};
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

  function handleAgentText(text) {
    pushUniqueText(texts, text);
    emitEvent({ type: "assistant", message: { content: [{ type: "text", text }] } });
  }

  function handleNotification(notification) {
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
  }

  let client = null;
  function createClient() {
    return createCodexAppServerClient({
      command: options.codexAppServerCommand,
      args: options.codexAppServerArgs,
      cwd: options.cwd,
      env: options.codexAppServerEnv,
      onNotification: handleNotification,
    });
  }

  async function initializeClient(nextClient) {
    const brand = readRuntimeBrand();
    await nextClient.request("initialize", {
      clientInfo: { name: brand.clientInfoName, title: brand.clientInfoTitle, version: "0" },
      capabilities: { experimentalApi: true },
    });
  }

  async function requestThreadStart(params) {
    const policy = threadStartPolicy(systemPrompt, options);
    const startedAt = Date.now();
    let lastError = null;
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      if (!client) {
        client = createClient();
        await initializeClient(client);
      }
      try {
        const thread = await client.request("thread/start", params, { timeoutMs: policy.timeoutMs });
        codexDiagnostics = {
          ...withoutCodexRequestErrorDiagnostics(codexDiagnostics),
          codex_thread_start_attempts: attempt,
          codex_thread_start_timeout_ms: policy.timeoutMs,
          codex_thread_start_duration_ms: Date.now() - startedAt,
          ...(attempt > 1 ? { codex_thread_start_retried: true } : {}),
        };
        return thread;
      } catch (err) {
        lastError = err;
        codexDiagnostics = {
          ...codexDiagnostics,
          ...codexErrorDiagnostics(err),
          codex_thread_start_attempts: attempt,
          codex_thread_start_timeout_ms: policy.timeoutMs,
          codex_thread_start_duration_ms: Date.now() - startedAt,
          ...(attempt > 1 ? { codex_thread_start_retried: true } : {}),
        };
        if (!isCodexRequestTimeout(err, "thread/start") || attempt >= policy.attempts || options.abortSignal?.aborted) {
          throw err;
        }
        emitEvent({
          type: "runtime_warning",
          warning_kind: "codex_thread_start_retry",
          message: `Codex app-server thread/start timed out after ${policy.timeoutMs}ms; retrying with a fresh app-server.`,
        });
        client.close();
        client = null;
        await delay(policy.backoffMs, options.abortSignal);
      }
    }
    throw lastError || new Error("codex app-server request timed out: thread/start");
  }

  const abortHandler = () => {
    if (threadId && activeTurnId) {
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
    client?.close();
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
    client = createClient();
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortHandler();
      else options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    await initializeClient(client);
    let collaborationMode = codexCollaborationModePayload(options.nativeSubagents, {
      model: resolved.model,
      effort: normalizedEffort,
      systemPrompt,
    });
    if (collaborationMode) {
      try {
        await client.request("collaborationMode/list", {}, { timeoutMs: 5_000 });
      } catch (err) {
        emitEvent({
          type: "runtime_warning",
          warning_kind: "codex_collaboration_mode_unavailable",
          message: codexErrorMessage(err?.responseError || err),
        });
        collaborationMode = null;
      }
    }
    const mcpServers = codexMcpConfig(options.mcpServers);
    const fastMode = codexModelSupportsFastMode(resolved.model) && normalizeFastMode(options.fastMode, true);
    const config = {
      ...(fastMode ? { service_tier: "fast" } : {}),
      features: { fast_mode: fastMode },
      ...(Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {}),
    };
    if (normalizedEffort) {
      config.model_reasoning_effort = normalizedEffort;
      if (normalizedEffort !== "none") config.model_reasoning_summary = "auto";
    }
    // intelligence-ramp Phase 5.2: codex-app's protocol revision shipped with
    // Worklab today exposes thread/start but no thread/load primitive, so
    // continuations always start a fresh thread. We still record the
    // returned thread id as provider_session_id so the run log links the
    // chain. TODO(intelligence-ramp): add thread/load + reusableSessionId
    // pass-through when the codex protocol supports resume.
    const thread = await requestThreadStart({
      model: resolved.model,
      modelProvider: "openai",
      ...(fastMode ? { serviceTier: "fast" } : {}),
      cwd: options.cwd || process.cwd(),
      approvalPolicy: approvalPolicyForPermissionMode(options.permissionMode),
      sandbox: sandboxForPermissionMode(options.permissionMode),
      config,
      serviceName: readRuntimeBrand().serviceName,
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
    const turnParams = {
      threadId,
      input: userTextInput(prompt),
      cwd: options.cwd || process.cwd(),
      approvalPolicy: approvalPolicyForPermissionMode(options.permissionMode),
      sandboxPolicy: options.permissionMode === "bypassPermissions" ? { type: "dangerFullAccess" } : null,
      model: resolved.model,
      ...(fastMode ? { serviceTier: "fast" } : {}),
      effort: normalizedEffort,
      summary: normalizedEffort && normalizedEffort !== "none" ? "auto" : "none",
      outputSchema: options.outputSchema,
      ...(collaborationMode ? { collaborationMode } : {}),
    };
    let turn;
    try {
      turn = await client.request("turn/start", turnParams);
    } catch (err) {
      if (!collaborationMode) throw err;
      emitEvent({
        type: "runtime_warning",
        warning_kind: "codex_collaboration_mode_rejected",
        message: codexErrorMessage(err?.responseError || err),
      });
      const fallbackParams = { ...turnParams };
      delete fallbackParams.collaborationMode;
      turn = await client.request("turn/start", fallbackParams);
    }
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

    const text = texts[texts.length - 1] || "";
    let codexErrorCode = prematureClose ? "codex_app_server_closed" : null;
    if (!errorMessage && !text.trim()) {
      errorMessage = "codex app-server completed without final output";
      failureKind = "provider_unavailable";
      codexErrorCode = codexErrorCode || "codex_app_server_no_output";
    }
    const hadPartialProgress = events.length > 0 || texts.length > 0;
    const reference = `codex:${resolved.model}`;
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? usage?.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage?.cache_creation_tokens ?? usage?.cacheCreationTokens ?? 0;
    const billableInputTokens = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
    const costUsd = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: billableInputTokens,
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
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: enrichedUsage,
      durationMs: Date.now() - start,
      numTurns: 1,
      model: reference,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: threadId || null,
      provider_session_id: threadId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind,
      diagnostics: {
        ...codexDiagnostics,
        ...(codexErrorCode ? { codex_error_code: codexErrorCode } : {}),
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
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage,
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: resolved?.reference || `codex:${resolved?.model || ""}`,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: threadId || null,
      provider_session_id: threadId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: err?.message || String(err),
      failureKind: failureKind || "provider_unavailable",
      diagnostics: {
        ...codexDiagnostics,
        ...codexErrorDiagnostics(err),
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
    options.abortSignal?.removeEventListener?.("abort", abortHandler);
    client?.close();
  }
}

export const codexAppBackend = {
  kind: "codex-app",
  capabilities: CODEX_APP_CAPABILITIES,
  execute: generateCodexAppResponse,
};

// CLI bridge for sdk='codex' agents that opt into execution_mode='cli'. The
// codex `app-server` is more capable than `codex exec` (better event
// streaming, MCP support), so this is the default CLI path for Codex.
export const codexAppRuntimeBridge = {
  id: "codex-app",
  kind: "codex-app",
  capabilities: CODEX_APP_CAPABILITIES,
  supports: (ref, options) => ref?.sdk === "codex" && options?.executionMode === "cli",
  execute: generateCodexAppResponse,
};
