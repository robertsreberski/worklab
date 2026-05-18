import { Agent } from "@earendil-works/pi-agent-core";
import * as openAiCodexResponses from "@earendil-works/pi-ai/openai-codex-responses";
import { randomUUID } from "node:crypto";
import { estimateCost } from "../cost.js";
import { PROVIDER_ABORT_RE } from "../failure.js";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import {
  createAgentCompactionManager,
  isLikelyContextTermination,
} from "../../agent/compaction.js";
import {
  closePiMcpClients,
  createStructuredOutputTool,
  getPiBuiltinTools,
  initPiMcpTools,
} from "../../agent/tools/pi-bridge.js";
import { createApprovalManager } from "../../agent/approval.js";
import { buildCapabilitiesUsed, toolCompactionAppliedFromWarnings } from "../runtime/capabilities-used.js";
import { resolvePiRuntimeModel } from "./pi-models.js";
import {
  promptTextFromMessages,
  textFromContent,
  thinkingFromContent,
  toAgentMessages,
  toolResultContent,
} from "./pi-messages.js";
import {
  compactToolRawResult,
  emitCaptured,
  eventToolArgs,
  jsonSerializable,
  streamContentKey,
} from "./pi-events.js";

function usageFromMessages(messages = []) {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const next = message.usage || {};
    usage.input += Number(next.input) || 0;
    usage.output += Number(next.output) || 0;
    usage.cacheRead += Number(next.cacheRead) || 0;
    usage.cacheWrite += Number(next.cacheWrite) || 0;
    usage.cost += Number(next.cost?.total) || 0;
  }
  return usage;
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function textToolResult(text, details = {}) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details,
  };
}

function usageFromRuntimeResult(result) {
  const usage = result?.usage || {};
  return {
    input: Number(usage.input_tokens ?? usage.input) || 0,
    output: Number(usage.output_tokens ?? usage.output) || 0,
    cacheRead: Number(usage.cache_read_tokens ?? usage.cacheRead) || 0,
    cacheWrite: Number(usage.cache_creation_tokens ?? usage.cache_write_tokens ?? usage.cacheWrite) || 0,
    cost: Number(usage.cost_usd ?? usage.cost?.total ?? usage.cost) || 0,
  };
}

function addUsage(target, addition) {
  target.input += Number(addition.input) || 0;
  target.output += Number(addition.output) || 0;
  target.cacheRead += Number(addition.cacheRead) || 0;
  target.cacheWrite += Number(addition.cacheWrite) || 0;
  target.cost += Number(addition.cost) || 0;
}

function thinkingLevelForEffort(effort, capabilities) {
  if (!capabilities?.reasoning || capabilities.reasoning_mode === "none") return "off";
  if (effort === "none") return "off";
  if (effort === "max") return "xhigh";
  if (effort === "xhigh") return "xhigh";
  if (effort === "high") return "high";
  if (effort === "medium") return "medium";
  return "low";
}

function appendStructuredOutputInstruction(systemPrompt, outputSchema) {
  if (!outputSchema) return systemPrompt;
  return [
    systemPrompt,
    "",
    "Structured output is available through the `StructuredOutput` tool.",
    "When the final result is ready, call `StructuredOutput` with the complete JSON object matching the requested schema.",
    "Do not also print the same JSON as prose unless tool calling is unavailable.",
  ].join("\n");
}

function structuredOutputFinalizationPrompt() {
  return [
    "The previous assistant turn ended without submitting the required structured result.",
    "Do not run tools, inspect files, or redo work.",
    "Call only `StructuredOutput` once with the final object matching the requested schema, based on the completed transcript above.",
    "Do not print prose before or after the tool call.",
  ].join("\n");
}

function shouldRetryStructuredOutputFinalization({
  outputSchema,
  structuredResult,
  finalText,
  stopReason,
  externalAbort,
  maxTurnsHit,
}) {
  if (!outputSchema) return false;
  if (structuredResult !== null && structuredResult !== undefined) return false;
  if (String(finalText || "").trim()) return false;
  if (externalAbort || maxTurnsHit) return false;
  return stopReason !== "error" && stopReason !== "aborted";
}

function structuredOutputRetryDiagnostics(attempts, reason, failed) {
  if (!attempts) return {};
  return {
    structured_output_finalization_retry_attempts: attempts,
    structured_output_finalization_retry_reason: reason,
    structured_output_finalization_retry_failed: !!failed,
  };
}

async function resolveApiKey(provider, { apiKeys, resolvePiApiKey, runtimeWarnings }) {
  if (apiKeys?.has(provider)) return apiKeys.get(provider);
  if (typeof resolvePiApiKey !== "function") return undefined;
  try {
    return await resolvePiApiKey(provider);
  } catch (err) {
    runtimeWarnings.push({
      warning_kind: "pi_auth_failed",
      provider,
      message: err?.message || String(err),
    });
    return undefined;
  }
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function normalizePiErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const codexMatch = /^Codex error:\s*(\{[\s\S]*\})$/i.exec(text);
  const parsed = tryParseJson(codexMatch ? codexMatch[1] : text);
  const nested = parsed?.error || parsed;
  if (typeof nested?.message === "string" && nested.message.trim()) return nested.message.trim();
  if (typeof nested?.error?.message === "string" && nested.error.message.trim()) return nested.error.message.trim();
  return text;
}

export function isContextLimitError(message) {
  const text = String(message || "");
  if (/rate limit|too many requests/i.test(text)) return false;
  return /context[_ ]length[_ ]exceeded|exceeds the context window|too many tokens|maximum context length|token limit exceeded|prompt is too long/i.test(text);
}

function failureKindForPiError(message, diagnostics, { maxTurnsHit = false } = {}) {
  if (!message) return null;
  if (maxTurnsHit || isContextLimitError(message) || isLikelyContextTermination(message, diagnostics)) return "usage_limit";
  return "provider_unavailable";
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function capturePiErrorPayload(message) {
  if (!message) return null;
  const errorMessage = pickFirstString(
    message.errorMessage,
    message.error?.errorMessage,
    message.error?.message,
  );
  const code = pickFirstString(
    message.code,
    message.error?.code,
    message.cause?.code,
    message.errorCode,
    message.error?.error?.code,
  );
  const requestId = pickFirstString(
    message.requestId,
    message.request_id,
    message.error?.requestId,
    message.error?.request_id,
  );
  const stopReason = pickFirstString(message.stopReason, message.stop_reason);
  if (!errorMessage && !code && !requestId && !stopReason) return null;
  return {
    stop_reason: stopReason,
    error_message: errorMessage,
    code,
    request_id: requestId,
  };
}

function pickPiErrorCodeFromException(err) {
  if (!err) return null;
  return pickFirstString(
    err.code,
    err.cause?.code,
    err.errno && String(err.errno),
  );
}

function inferPiErrorCode(message) {
  if (/websocket/i.test(String(message || ""))) return "websocket_error";
  return null;
}

function lastTextSnippet(...sources) {
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const arr = sources[i];
    if (!Array.isArray(arr)) continue;
    for (let j = arr.length - 1; j >= 0; j -= 1) {
      const text = arr[j];
      if (typeof text === "string" && text.trim()) {
        const trimmed = text.trim();
        return trimmed.length > 200 ? trimmed.slice(-200) : trimmed;
      }
    }
  }
  return null;
}

function readRuntimeSettings(explicitSettings) {
  // Settings are now resolved by the caller (core/ai.js#generateResponse)
  // and passed in via options.settings. The provider no longer reaches
  // back into core/settings.js.
  return explicitSettings && typeof explicitSettings === "object" ? explicitSettings : {};
}

const PI_CODEX_TRANSPORTS = new Set(["sse", "auto", "websocket", "websocket-cached"]);
const PI_CODEX_WEBSOCKET_TRANSPORTS = new Set(["auto", "websocket", "websocket-cached"]);

function resolvePiTransport(model, runtimeWarnings, requested) {
  if (model?.api !== "openai-codex-responses") return "auto";
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return "sse";
  const transport = raw.toLowerCase();
  if (PI_CODEX_TRANSPORTS.has(transport)) return transport;
  runtimeWarnings.push({
    warning_kind: "invalid_pi_codex_transport",
    message: "Ignoring invalid piCodexTransport; expected sse, auto, websocket, or websocket-cached.",
    value: raw,
  });
  return "sse";
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeDiagnosticsObject(value) {
  if (!isPlainObject(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        item == null
        || typeof item === "string"
        || typeof item === "number"
        || typeof item === "boolean"
      ) {
        out[key] = item;
      }
    }
    return Object.keys(out).length ? out : null;
  }
}

function piWebSocketDebugStats(providerSessionId, transport) {
  if (!providerSessionId || !PI_CODEX_WEBSOCKET_TRANSPORTS.has(transport)) return null;
  try {
    const stats = openAiCodexResponses.getOpenAICodexWebSocketDebugStats?.(providerSessionId);
    return sanitizeDiagnosticsObject(stats);
  } catch {
    return null;
  }
}

function normalizeTransportFailureDiagnostic(diagnostic) {
  if (!isPlainObject(diagnostic) || diagnostic.type !== "provider_transport_failure") return null;
  const details = isPlainObject(diagnostic.details) ? diagnostic.details : {};
  const error = isPlainObject(diagnostic.error) ? diagnostic.error : {};
  return {
    type: "provider_transport_failure",
    error_message: typeof error.message === "string" ? error.message : null,
    error_name: typeof error.name === "string" ? error.name : null,
    configured_transport: typeof details.configuredTransport === "string" ? details.configuredTransport : null,
    fallback_transport: typeof details.fallbackTransport === "string" ? details.fallbackTransport : null,
    phase: typeof details.phase === "string" ? details.phase : null,
    events_emitted: typeof details.eventsEmitted === "boolean" ? details.eventsEmitted : null,
    request_bytes: Number.isFinite(Number(details.requestBytes)) ? Number(details.requestBytes) : null,
  };
}

function latestTransportFailureDiagnostic(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const diagnostics = Array.isArray(messages[i]?.diagnostics) ? messages[i].diagnostics : [];
    for (let j = diagnostics.length - 1; j >= 0; j -= 1) {
      const normalized = normalizeTransportFailureDiagnostic(diagnostics[j]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function piNativeTeammates(nativeSubagents) {
  if (nativeSubagents?.provider !== "pi" || !Array.isArray(nativeSubagents.teammates)) return [];
  return nativeSubagents.teammates.filter((agent) => agent?.name && agent?.helperSystemPrompt);
}

function createPiSubagentTool(nativeSubagents, parentOptions, recordResult) {
  const teammates = piNativeTeammates(nativeSubagents);
  if (!teammates.length) return null;
  const byName = new Map(teammates.map((agent) => [agent.name, agent]));
  const maxTasks = Math.max(1, Number(nativeSubagents.maxChildrenPerRound) || 1);
  const maxParallel = Math.max(1, Number(nativeSubagents.maxParallelChildren) || 1);

  async function runTask(task, signal, onUpdate) {
    const agentName = String(task?.agent || "").trim();
    const prompt = String(task?.prompt || "").trim();
    if (!agentName) throw new Error("AskAgent requires an agent name.");
    if (!prompt) throw new Error("AskAgent requires a prompt.");
    const target = byName.get(agentName);
    if (!target) throw new Error(`AskAgent target ${agentName} is not an available native teammate.`);
    onUpdate?.(textToolResult(`Asking ${agentName}...`, { agent: agentName, status: "running" }));
    const child = await generatePiResponse(target.helperSystemPrompt, {
      ...parentOptions,
      model: target.model || parentOptions.model,
      effort: target.effort || parentOptions.effort,
      messages: [{ role: "user", content: prompt }],
      skills: Array.isArray(target.skills) ? target.skills : [],
      skillDirs: Array.isArray(target.skillDirs) ? target.skillDirs : [],
      mcpServers: target.mcpServers || {},
      allowedTools: Array.isArray(target.allowedTools) ? target.allowedTools : [],
      disallowedTools: Array.isArray(target.disallowedTools) ? target.disallowedTools : [],
      toolPolicy: target.toolPolicy || {},
      nativeSubagents: null,
      outputSchema: null,
      liveInput: null,
      onEvent: null,
      providerSessionId: null,
      sessionId: `${parentOptions.runId || "pi"}:subagent:${agentName}:${randomUUID()}`,
      abortSignal: signal || parentOptions.abortSignal,
    });
    const summary = {
      agent: agentName,
      prompt,
      text: child.text || "",
      error: child.error || null,
      usage: child.usage || {},
      durationMs: child.durationMs || 0,
      numTurns: child.numTurns || 0,
    };
    recordResult(summary);
    if (child.cancelled) throw new Error(`AskAgent target ${agentName} was cancelled.`);
    if (child.error) throw new Error(`AskAgent target ${agentName} failed: ${child.error}`);
    return summary;
  }

  return {
    name: "AskAgent",
    label: "Ask Agent",
    description: `Ask one of these native teammate agents for bounded help: ${teammates.map((agent) => agent.name).join(", ")}.`,
    executionMode: nativeSubagents.mode === "workspace" ? "parallel" : "sequential",
    parameters: objectSchema({
      agent: { type: "string", enum: teammates.map((agent) => agent.name) },
      prompt: { type: "string", description: "A bounded request for the teammate agent." },
      tasks: {
        type: "array",
        maxItems: maxTasks,
        items: objectSchema({
          agent: { type: "string", enum: teammates.map((agent) => agent.name) },
          prompt: { type: "string" },
        }, ["agent", "prompt"]),
      },
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      const requestedTasks = Array.isArray(params?.tasks) && params.tasks.length
        ? params.tasks
        : [{ agent: params?.agent, prompt: params?.prompt }];
      if (requestedTasks.length > maxTasks) {
        throw new Error(`AskAgent received ${requestedTasks.length} tasks, above the configured limit of ${maxTasks}.`);
      }
      const results = [];
      for (let i = 0; i < requestedTasks.length; i += maxParallel) {
        const batch = requestedTasks.slice(i, i + maxParallel);
        results.push(...await Promise.all(batch.map((task) => runTask(task, signal, onUpdate))));
      }
      const body = results.map((result) => [
        `### ${result.agent}`,
        result.text || "(no text returned)",
      ].join("\n\n")).join("\n\n");
      return textToolResult(body, {
        mode: nativeSubagents.mode || "advisory",
        tasks: results,
      });
    },
  };
}

export async function generatePiResponse(systemPrompt, options = {}) {
  const resolved = options.model;
  const start = Date.now();
  const events = [];
  const runtimeWarnings = [];
  const assistantTexts = [];
  const assistantThinking = [];
  const textDeltaIndexes = new Set();
  const thinkingDeltaIndexes = new Set();
  let structuredResult = null;
  let mcpClients = [];
  let finalMessages = [];
  let externalAbort = false;
  let maxTurnsHit = false;
  let turnCount = 0;
  let compaction = null;
  let piErrorPayload = null;
  let toolResultsSeen = 0;
  let lastToolName = null;
  let piTransport = "auto";
  let agent = null;
  let removeAbortHandler = null;
  let structuredOutputFinalizationRetryAttempts = 0;
  let structuredOutputFinalizationRetryReason = null;
  let structuredOutputFinalizationRetryFailed = false;
  const subagentResults = [];
  const providerSessionId = options.sessionId
    || options.providerSessionId
    || options.runId
    || randomUUID();

  const onEvent = (event) => emitCaptured(events, options.onEvent, event);
  const approvalManager = options.onToolApprovalRequest
    ? createApprovalManager({
      onToolApprovalRequest: options.onToolApprovalRequest,
      defaultRiskTier: options.approvalDefaultRiskTier,
      timeoutMs: options.approvalTimeoutMs,
      onEvent,
      riskTiersByTool: options.toolRiskTiers,
      alwaysAllowTools: options.approvalAlwaysAllowTools,
    })
    : null;

  try {
    const runtime = resolvePiRuntimeModel(resolved, options);
    piTransport = resolvePiTransport(runtime.model, runtimeWarnings, options.piCodexTransport);
    const capabilities = runtime.capabilities || {};
    const settings = readRuntimeSettings(options.settings);
    const reference = resolved.reference
      || (resolved.sdk === "pi" ? `pi:${resolved.provider}:${resolved.model}` : `${resolved.sdk}:${resolved.model}`);
    compaction = createAgentCompactionManager({
      runId: options.runId || null,
      providerKind: resolved.sdk,
      modelReference: reference,
      model: runtime.model,
      settings,
      onEvent,
      onCompactionRecorded: options.onCompactionRecorded,
    });
    const onTruncate = (info) => {
      try {
        onEvent({
          type: "runtime_warning",
          warning_kind: "tool_payload_truncated",
          source: "tool_bloat_guard",
          ...info,
        });
      } catch { /* best-effort */ }
    };
    const persistArtifact = options.persistArtifact || null;
    const qaOutputDir = options.qaOutputDir || options.runArtifactDir || null;
    const toolPayloadMaxBytes = compaction.policy?.toolPayloadMaxBytes;
    const builtIns = capabilities.tool_use === false
      ? []
      : getPiBuiltinTools(options.allowedTools, {
        skillNames: (options.skills || []).map((skill) => skill.name),
        dataDir: options.dataDir,
        cwd: options.cwd,
        onEvent,
        toolLimits: compaction.policy,
        persistArtifact,
        toolPayloadMaxBytes,
        onTruncate,
        toolPolicy: options.toolPolicy,
        approvalManager,
        approvalModel: runtime.model?.id || runtime.model?.name || resolved.model,
      });

    const structuredTool = createStructuredOutputTool(options.outputSchema, (value) => {
      structuredResult = value;
    });
    const subagentTool = capabilities.tool_use === false
      ? null
      : createPiSubagentTool(options.nativeSubagents, options, (result) => subagentResults.push(result));
    const reservedNames = new Set(builtIns.map((toolDef) => toolDef.name));
    if (subagentTool) reservedNames.add(subagentTool.name);
    if (structuredTool) reservedNames.add(structuredTool.name);
    const mcpInit = capabilities.tool_use === false
      ? { clients: [], tools: [], warnings: [] }
      : await initPiMcpTools(options.mcpServers || {}, reservedNames, {
        limits: compaction.policy,
        cwd: options.cwd,
        persistArtifact,
        qaOutputDir,
        toolPayloadMaxBytes,
        onTruncate,
      });
    mcpClients = mcpInit.clients;
    for (const warning of mcpInit.warnings || []) onEvent(warning);

    const tools = [
      ...builtIns,
      ...(subagentTool ? [subagentTool] : []),
      ...mcpInit.tools,
      ...(structuredTool ? [structuredTool] : []),
    ];

    agent = new Agent({
      initialState: {
        systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema),
        model: runtime.model,
        thinkingLevel: thinkingLevelForEffort(options.effort || "medium", capabilities),
        tools,
      },
      streamFn: options.streamFn,
      transformContext: compaction.transformContext,
      afterToolCall: compaction.afterToolCall,
      sessionId: providerSessionId,
      transport: piTransport,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      toolExecution: "sequential",
      getApiKey: (provider) => resolveApiKey(provider, {
        apiKeys: runtime.apiKeys,
        resolvePiApiKey: options.resolvePiApiKey,
        runtimeWarnings,
      }),
      maxRetryDelayMs: options.maxRetryDelayMs || 60_000,
    });

    agent.subscribe((event) => {
      if (event.type === "message_update") {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent?.type === "text_delta" && streamEvent.delta) {
          textDeltaIndexes.add(streamContentKey(streamEvent, "text"));
          assistantTexts.push(streamEvent.delta);
          onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.delta }] } });
        } else if (streamEvent?.type === "text_end" && streamEvent.content) {
          const key = streamContentKey(streamEvent, "text");
          if (!textDeltaIndexes.has(key)) {
            assistantTexts.push(streamEvent.content);
            onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.content }] } });
          }
        } else if (streamEvent?.type === "thinking_delta" && streamEvent.delta) {
          thinkingDeltaIndexes.add(streamContentKey(streamEvent, "thinking"));
          assistantThinking.push(streamEvent.delta);
          onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.delta }] } });
        } else if (streamEvent?.type === "thinking_end" && streamEvent.content) {
          const key = streamContentKey(streamEvent, "thinking");
          if (!thinkingDeltaIndexes.has(key)) assistantThinking.push(streamEvent.content);
          onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.content }] } });
        }
      } else if (event.type === "tool_execution_start") {
        if (event.toolName) lastToolName = event.toolName;
        const input = eventToolArgs(event.toolName, event.args, {
          cwd: options.cwd,
          toolLimits: compaction?.policy,
        });
        onEvent({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input }] },
        });
      } else if (event.type === "tool_execution_update") {
        const input = eventToolArgs(event.toolName, event.args, {
          cwd: options.cwd,
          toolLimits: compaction?.policy,
        });
        onEvent({
          type: "tool_update",
          tool_use_id: event.toolCallId,
          name: event.toolName,
          input,
          partial_result: jsonSerializable(event.partialResult, String(event.partialResult ?? "")),
        });
      } else if (event.type === "tool_execution_end") {
        const resultContent = toolResultContent(event.result);
        if (!event.isError) toolResultsSeen += 1;
        onEvent({
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: event.toolCallId,
              content: resultContent,
              raw_result: compactToolRawResult(jsonSerializable(event.result, resultContent), resultContent),
              is_error: !!event.isError,
            }],
          },
        });
      } else if (event.type === "turn_end") {
        turnCount += 1;
        if (Number.isFinite(Number(options.maxTurns))
          && Number(options.maxTurns) > 0
          && turnCount >= Number(options.maxTurns)
          && event.message?.stopReason === "toolUse") {
          maxTurnsHit = true;
          agent.abort();
        }
      } else if (event.type === "agent_end") {
        finalMessages = event.messages || [];
      }
    });

    const abortHandler = () => {
      externalAbort = true;
      agent.abort();
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        externalAbort = true;
        return {
          text: null,
          thinking: "",
          events,
          usage: {},
          durationMs: Date.now() - start,
          numTurns: turnCount,
          model: resolved?.reference || resolved?.model || null,
          effort: options.effort || null,
          sdk: resolved?.sdk || "pi",
          cancelled: true,
          error: null,
          failureKind: null,
          providerSessionId,
          runtimeWarnings,
          diagnostics: {
            provider_session_id: providerSessionId,
            pi_stop_reason: "aborted",
            max_turns_hit: false,
            max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
            pi_transport: piTransport,
            turn_count: turnCount,
            external_abort: true,
            ...(compaction?.diagnostics?.() || {}),
          },
        };
      }
      else {
        options.abortSignal.addEventListener("abort", abortHandler, { once: true });
        removeAbortHandler = () => options.abortSignal.removeEventListener?.("abort", abortHandler);
      }
    }

    if (options.liveInput) {
      (async () => {
        try {
          for await (const message of options.liveInput) {
            if (options.abortSignal?.aborted) break;
            agent.steer({
              role: "user",
              content: formatLiveInputGuidance(message.body),
              timestamp: message.createdAt || Date.now(),
            });
          }
        } catch (err) {
          onEvent({
            type: "runtime_warning",
            warning_kind: "live_input_failed",
            message: err?.message || String(err),
          });
        }
      })();
    }

    onEvent({
      type: "provider_request_started",
      sdk: resolved.sdk,
      model: reference,
      runtime: "pi",
      timestamp: Date.now(),
    });

    await agent.prompt(toAgentMessages(options.messages, runtime.model));

    const streamRetryMax = Number.isFinite(Number(options.piStreamRetryMax))
      ? Math.max(0, Math.min(5, Number(options.piStreamRetryMax)))
      : 2;
    const streamRetryBaseMs = Number.isFinite(Number(options.piStreamRetryBaseMs))
      ? Math.max(0, Number(options.piStreamRetryBaseMs))
      : 1000;
    let streamRetryAttempts = 0;
    const streamRetryEvents = [];
    while (streamRetryAttempts < streamRetryMax) {
      if (externalAbort || options.abortSignal?.aborted) break;
      const msgs = agent.state?.messages || [];
      let lastAssistant = null;
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === "assistant") { lastAssistant = msgs[i]; break; }
      }
      const lastStopReason = lastAssistant?.stopReason || null;
      const lastErrorMessage = String(lastAssistant?.errorMessage || "");
      if (lastStopReason !== "error") break;
      if (!PROVIDER_ABORT_RE.test(lastErrorMessage)) break;
      streamRetryAttempts += 1;
      const attempt = streamRetryAttempts;
      streamRetryEvents.push({ attempt, reason: lastErrorMessage });
      runtimeWarnings.push({
        warning_kind: "pi_stream_retry",
        source: "pi",
        reason: lastErrorMessage,
        attempt,
        message: `Retrying pi stream after ${lastErrorMessage} (attempt ${attempt}/${streamRetryMax}).`,
      });
      onEvent({
        type: "runtime_warning",
        warning_kind: "pi_stream_retry",
        reason: lastErrorMessage,
        attempt,
      });
      while (
        agent.state.messages.length > 0
        && agent.state.messages[agent.state.messages.length - 1]?.role === "assistant"
      ) {
        agent.state.messages.pop();
      }
      if (agent.state.messages.length === 0) break;
      if (streamRetryBaseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, streamRetryBaseMs * (2 ** (attempt - 1))));
      }
      if (externalAbort || options.abortSignal?.aborted) break;
      try {
        await agent.continue();
      } catch (err) {
        runtimeWarnings.push({
          warning_kind: "pi_stream_retry_failed",
          source: "pi",
          attempt,
          message: err?.message || String(err),
        });
        break;
      }
    }

    const captureState = () => {
      const transcript = agent.state.messages || [];
      const assistantMessages = transcript.filter((message) => message?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      return {
        transcript,
        assistantMessages,
        lastAssistant,
        piTransportFailure: latestTransportFailureDiagnostic(assistantMessages),
        piWebSocketDebug: piWebSocketDebugStats(providerSessionId, piTransport),
        finalText: textFromContent(lastAssistant?.content) || assistantTexts.join(""),
        finalThinking: thinkingFromContent(lastAssistant?.content) || assistantThinking.join(""),
        stopReason: lastAssistant?.stopReason || null,
      };
    };

    let state = captureState();
    externalAbort ||= !!options.abortSignal?.aborted;
    if (shouldRetryStructuredOutputFinalization({
      outputSchema: options.outputSchema,
      structuredResult,
      finalText: state.finalText,
      stopReason: state.stopReason,
      externalAbort,
      maxTurnsHit,
    })) {
      structuredOutputFinalizationRetryAttempts = 1;
      structuredOutputFinalizationRetryReason = "empty_final_output";
      runtimeWarnings.push({
        warning_kind: "structured_output_finalization_retry",
        source: "pi",
        reason: structuredOutputFinalizationRetryReason,
        message: "Pi stopped without text or structured output; retrying once in the same session with only StructuredOutput enabled.",
      });
      const previousTools = agent.state.tools;
      try {
        agent.state.tools = structuredTool ? [structuredTool] : [];
        agent.followUp({
          role: "user",
          content: structuredOutputFinalizationPrompt(),
          timestamp: Date.now(),
        });
        await agent.continue();
      } finally {
        agent.state.tools = previousTools;
      }
      structuredOutputFinalizationRetryFailed = structuredResult === null || structuredResult === undefined;
      state = captureState();
    }

    const {
      transcript,
      assistantMessages,
      lastAssistant,
      piTransportFailure,
      piWebSocketDebug,
      finalText,
      finalThinking,
      stopReason,
    } = state;
    const text = finalText;
    const usage = usageFromMessages(transcript);
    for (const child of subagentResults) addUsage(usage, usageFromRuntimeResult(child));
    const estimatedCost = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    });
    if (usage.cacheRead > 0) {
      onEvent({ type: "cache_hit", sdk: resolved.sdk, model: reference, tokens: usage.cacheRead, source: "prompt_cache" });
    }
    if (usage.cacheWrite > 0) {
      onEvent({ type: "cache_miss", sdk: resolved.sdk, model: reference, tokens: usage.cacheWrite, source: "prompt_cache" });
    }
    onEvent({
      type: "cost_accumulated",
      sdk: resolved.sdk,
      model: reference,
      cumulativeUsd: Number(usage.cost) || Number(estimatedCost) || 0,
      tokens: {
        input: Number(usage.input) || 0,
        output: Number(usage.output) || 0,
        cacheReadTokens: Number(usage.cacheRead) || 0,
        cacheCreationTokens: Number(usage.cacheWrite) || 0,
      },
    });
    onEvent({
      type: "provider_request_completed",
      sdk: resolved.sdk,
      model: reference,
      runtime: "pi",
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      cancelled: externalAbort,
    });
    if (!piErrorPayload && (stopReason === "error" || stopReason === "aborted")) {
      piErrorPayload = capturePiErrorPayload(lastAssistant);
    }
    const rawErrorMessage = externalAbort
      ? null
      : maxTurnsHit
        ? "Pi agent stopped before final output: max turns reached"
        : (stopReason === "error" || stopReason === "aborted"
            ? piErrorPayload?.error_message
              || lastAssistant?.errorMessage
              || agent.state.errorMessage
              || "Pi agent aborted before final output"
            : null);
    const errorMessage = normalizePiErrorMessage(rawErrorMessage);
    const piErrorCode = piErrorPayload?.code || inferPiErrorCode(errorMessage);
    const hadPartialProgress = !externalAbort
      && (stopReason === "error" || stopReason === "aborted")
      && (toolResultsSeen > 0 || assistantTexts.length > 0 || assistantThinking.length > 0);
    const errorDetails = errorMessage ? {
      pi_stop_reason: stopReason,
      pi_error_code: piErrorCode || null,
      pi_request_id: piErrorPayload?.request_id || null,
      last_text_excerpt: lastTextSnippet(assistantTexts, assistantThinking),
      last_tool_name: lastToolName,
      had_partial_progress: hadPartialProgress,
      tool_results_seen: toolResultsSeen,
      turn_count: turnCount || assistantMessages.length || finalMessages.length,
      max_turns_hit: maxTurnsHit,
      provider_session_id: providerSessionId,
      pi_transport: piTransport,
      ...structuredOutputRetryDiagnostics(
        structuredOutputFinalizationRetryAttempts,
        structuredOutputFinalizationRetryReason,
        structuredOutputFinalizationRetryFailed,
      ),
      ...(piTransportFailure ? { pi_transport_failure: piTransportFailure } : {}),
      ...(piWebSocketDebug ? { pi_websocket_debug: piWebSocketDebug } : {}),
    } : null;
    const diagnostics = {
      provider_session_id: providerSessionId,
      pi_stop_reason: stopReason,
      pi_transport: piTransport,
      max_turns_hit: maxTurnsHit,
      max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
      turn_count: turnCount || assistantMessages.length || finalMessages.length,
      external_abort: externalAbort,
      ...(piErrorCode ? { pi_error_code: piErrorCode } : {}),
      ...(piErrorPayload?.request_id ? { pi_request_id: piErrorPayload.request_id } : {}),
      ...(piErrorPayload ? { pi_error_payload: piErrorPayload } : {}),
      ...(piTransportFailure ? { pi_transport_failure: piTransportFailure } : {}),
      ...(piWebSocketDebug ? { pi_websocket_debug: piWebSocketDebug } : {}),
      ...(lastToolName ? { last_tool_name: lastToolName } : {}),
      ...structuredOutputRetryDiagnostics(
        structuredOutputFinalizationRetryAttempts,
        structuredOutputFinalizationRetryReason,
        structuredOutputFinalizationRetryFailed,
      ),
      ...(hadPartialProgress ? { had_partial_progress: true, tool_results_seen: toolResultsSeen } : {}),
      ...(streamRetryAttempts > 0
        ? { pi_stream_retries: streamRetryAttempts, pi_stream_retry_events: streamRetryEvents }
        : {}),
      ...(subagentResults.length ? {
        pi_subagents: {
          count: subagentResults.length,
          errors: subagentResults.filter((child) => child.error).length,
          agents: subagentResults.map((child) => child.agent),
        },
      } : {}),
      ...(compaction?.diagnostics?.() || {}),
    };

    const compactionDiag = compaction?.diagnostics?.() || {};
    const capabilitiesUsed = buildCapabilitiesUsed({
      promptCacheActive: usage.cacheRead > 0 || usage.cacheWrite > 0,
      thinkingEnabled: options.effort && options.effort !== "none" && options.effort !== "low"
        ? true
        : (options.effort === "none" || options.effort === "low" ? false : null),
      structuredOutputEnforced: !!options.outputSchema,
      subagentInvoked: subagentResults.length > 0,
      mcpServersUsed: mcpClients.map((entry) => entry?.name).filter(Boolean),
      nativeSubagentsUsed: piNativeTeammates(options.nativeSubagents).map((entry) => entry.name),
      toolCompactionApplied: toolCompactionAppliedFromWarnings(runtimeWarnings),
      contextCompactionApplied: Number(compactionDiag?.context_compactions || 0) > 0
        ? true
        : compaction
          ? false
          : null,
    });
    onEvent({ type: "capabilities_resolved", sdk: resolved.sdk, model: reference, capabilitiesUsed });

    return {
      text,
      thinking: finalThinking,
      events,
      usage: {
        input_tokens: usage.input || null,
        output_tokens: usage.output || null,
        cache_read_tokens: usage.cacheRead || null,
        cache_creation_tokens: usage.cacheWrite || null,
        cache_write_tokens: usage.cacheWrite || null,
        cost_usd: usage.cost || estimatedCost,
      },
      durationMs: Date.now() - start,
      numTurns: turnCount || assistantMessages.length || finalMessages.length,
      model: resolved.reference || `pi:${resolved.provider}:${resolved.model}`,
      effort: options.effort || null,
      sdk: resolved.sdk,
      cancelled: externalAbort,
      error: errorMessage,
      errorDetails,
      failureKind: failureKindForPiError(errorMessage, diagnostics, { maxTurnsHit }),
      providerSessionId,
      runtimeWarnings,
      diagnostics,
      capabilitiesUsed,
      ...(structuredResult !== null && structuredResult !== undefined
        ? { structuredResult, structuredResultSource: "StructuredOutput" }
        : { structuredResult: undefined, structuredResultSource: null }),
    };
  } catch (err) {
    externalAbort ||= !!options.abortSignal?.aborted;
    const assistantMessages = Array.isArray(agent?.state?.messages)
      ? agent.state.messages.filter((message) => message?.role === "assistant")
      : [];
    const piTransportFailure = latestTransportFailureDiagnostic(assistantMessages);
    const piWebSocketDebug = piWebSocketDebugStats(providerSessionId, piTransport);
    const exceptionCode = pickPiErrorCodeFromException(err);
    const errorMessage = normalizePiErrorMessage(
      piErrorPayload?.error_message || err?.message || String(err),
    );
    const piErrorCode = piErrorPayload?.code || exceptionCode || inferPiErrorCode(errorMessage);
    const hadPartialProgress = !externalAbort
      && (toolResultsSeen > 0 || assistantTexts.length > 0 || assistantThinking.length > 0);
    const errorDetails = (!externalAbort && errorMessage) ? {
      pi_stop_reason: "error",
      pi_error_code: piErrorCode || null,
      pi_request_id: piErrorPayload?.request_id || null,
      last_text_excerpt: lastTextSnippet(assistantTexts, assistantThinking),
      last_tool_name: lastToolName,
      had_partial_progress: hadPartialProgress,
      tool_results_seen: toolResultsSeen,
      turn_count: turnCount,
      max_turns_hit: maxTurnsHit,
      provider_session_id: providerSessionId,
      pi_transport: piTransport,
      ...(piTransportFailure ? { pi_transport_failure: piTransportFailure } : {}),
      ...(piWebSocketDebug ? { pi_websocket_debug: piWebSocketDebug } : {}),
      ...structuredOutputRetryDiagnostics(
        structuredOutputFinalizationRetryAttempts,
        structuredOutputFinalizationRetryReason,
        true,
      ),
    } : null;
    return {
      text: assistantTexts.join("") || null,
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: turnCount,
      model: resolved?.reference || resolved?.model || null,
      effort: options.effort || null,
      sdk: resolved?.sdk || "pi",
      cancelled: externalAbort,
      error: externalAbort ? null : errorMessage,
      errorDetails,
      failureKind: externalAbort ? null : failureKindForPiError(errorMessage, {
        ...(compaction?.diagnostics?.() || {}),
      }, { maxTurnsHit }),
      providerSessionId,
      runtimeWarnings,
      diagnostics: {
        provider_session_id: providerSessionId,
        pi_stop_reason: externalAbort ? "aborted" : "error",
        pi_transport: piTransport,
        max_turns_hit: maxTurnsHit,
        max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
        turn_count: turnCount,
        external_abort: externalAbort,
        ...(piErrorCode
          ? { pi_error_code: piErrorCode }
          : {}),
        ...(piErrorPayload?.request_id ? { pi_request_id: piErrorPayload.request_id } : {}),
        ...(piErrorPayload ? { pi_error_payload: piErrorPayload } : {}),
        ...(piTransportFailure ? { pi_transport_failure: piTransportFailure } : {}),
        ...(piWebSocketDebug ? { pi_websocket_debug: piWebSocketDebug } : {}),
        ...(lastToolName ? { last_tool_name: lastToolName } : {}),
        ...structuredOutputRetryDiagnostics(
          structuredOutputFinalizationRetryAttempts,
          structuredOutputFinalizationRetryReason,
          true,
        ),
        ...(hadPartialProgress ? { had_partial_progress: true, tool_results_seen: toolResultsSeen } : {}),
        ...(compaction?.diagnostics?.() || {}),
      },
    };
  } finally {
    removeAbortHandler?.();
    await closePiMcpClients(mcpClients);
  }
}

export const piOpenAiBackend = {
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  execute: generatePiResponse,
};

export const piCodexBackend = {
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  execute: generatePiResponse,
};

export const piVercelBackend = {
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  execute: generatePiResponse,
};

export const piGenericBackend = {
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  execute: generatePiResponse,
};

export const piRuntimeBridge = {
  id: "pi",
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  supports: (ref) => ref?.sdk === "pi",
  execute: generatePiResponse,
};
