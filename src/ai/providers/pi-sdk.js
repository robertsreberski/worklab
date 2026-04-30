import { Agent } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import { estimateCost } from "../cost.js";
import { backendCapabilities } from "../backend.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import {
  createAgentCompactionManager,
  isLikelyContextTermination,
} from "../../agent/compaction.js";
import { resolvePiApiKey } from "../pi-oauth.js";
import {
  closePiMcpClients,
  createStructuredOutputTool,
  getPiBuiltinTools,
  initPiMcpTools,
} from "../../agent/tools/pi-bridge.js";
import { extractWorklabResult, formatWorklabResultText } from "../result/contract.js";
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

async function resolveApiKey(provider, { apiKeys, dataDir, runtimeWarnings }) {
  if (apiKeys?.has(provider)) return apiKeys.get(provider);
  try {
    return await resolvePiApiKey(provider, { dataDir });
  } catch (err) {
    runtimeWarnings.push({
      warning_kind: "pi_auth_failed",
      provider,
      message: err?.message || String(err),
    });
    return undefined;
  }
}

function worklabResultFromStructuredOrMessages({ structuredResult, messages, text }) {
  const source = structuredResult
    ? { type: "tool_use", name: "StructuredOutput", input: structuredResult }
    : { messages, text };
  const extracted = extractWorklabResult(source);
  return extracted.ok ? extracted.result : null;
}

function finalTextFromStructured(structuredResult, worklabResult) {
  if (worklabResult) return formatWorklabResultText(worklabResult) || JSON.stringify(worklabResult);
  if (structuredResult) return JSON.stringify(structuredResult);
  return null;
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

function readRuntimeSettings(explicitSettings) {
  // Settings are now resolved by the caller (core/ai.js#generateResponse)
  // and passed in via options.settings. The provider no longer reaches
  // back into core/settings.js.
  return explicitSettings && typeof explicitSettings === "object" ? explicitSettings : {};
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

  const onEvent = (event) => emitCaptured(events, options.onEvent, event);

  try {
    const runtime = resolvePiRuntimeModel(resolved, options);
    const capabilities = runtime.capabilities || {};
    const settings = readRuntimeSettings(options.settings);
    const reference = resolved.reference
      || (resolved.sdk === "pi" ? `pi:${resolved.provider}:${resolved.model}` : `${resolved.sdk}:${resolved.model}`);
    compaction = createAgentCompactionManager({
      db: options.db,
      runId: options.runId || process.env.WORKLAB_RUN_ID || null,
      providerKind: resolved.sdk,
      modelReference: reference,
      model: runtime.model,
      settings,
      onEvent,
    });
    const builtIns = capabilities.tool_use === false
      ? []
      : getPiBuiltinTools(options.allowedTools, {
        skillNames: (options.skills || []).map((skill) => skill.name),
        dataDir: options.dataDir,
        cwd: options.cwd,
        onEvent,
        toolLimits: compaction.policy,
      });

    const structuredTool = createStructuredOutputTool(options.outputSchema, (value) => {
      structuredResult = value;
    });
    const reservedNames = new Set(builtIns.map((toolDef) => toolDef.name));
    if (structuredTool) reservedNames.add(structuredTool.name);
    const mcpInit = capabilities.tool_use === false
      ? { clients: [], tools: [], warnings: [] }
      : await initPiMcpTools(options.mcpServers || {}, reservedNames, { limits: compaction.policy, cwd: options.cwd });
    mcpClients = mcpInit.clients;
    for (const warning of mcpInit.warnings || []) onEvent(warning);

    const tools = [
      ...builtIns,
      ...mcpInit.tools,
      ...(structuredTool ? [structuredTool] : []),
    ];

    const agent = new Agent({
      initialState: {
        systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema),
        model: runtime.model,
        thinkingLevel: thinkingLevelForEffort(options.effort || "medium", capabilities),
        tools,
      },
      streamFn: options.streamFn,
      transformContext: compaction.transformContext,
      afterToolCall: compaction.afterToolCall,
      sessionId: options.sessionId || options.runId || process.env.WORKLAB_RUN_ID || randomUUID(),
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      toolExecution: "sequential",
      getApiKey: (provider) => resolveApiKey(provider, {
        apiKeys: runtime.apiKeys,
        dataDir: options.dataDir,
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
          runtimeWarnings,
          diagnostics: {
            pi_stop_reason: "aborted",
            max_turns_hit: false,
            max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
            turn_count: turnCount,
            external_abort: true,
            ...(compaction?.diagnostics?.() || {}),
          },
        };
      }
      else options.abortSignal.addEventListener("abort", abortHandler, { once: true });
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

    try {
      await agent.prompt(toAgentMessages(options.messages, runtime.model));
    } finally {
      if (options.abortSignal) options.abortSignal.removeEventListener?.("abort", abortHandler);
    }

    const transcript = agent.state.messages || [];
    const assistantMessages = transcript.filter((message) => message?.role === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
    const finalText = textFromContent(lastAssistant?.content) || assistantTexts.join("");
    const finalThinking = thinkingFromContent(lastAssistant?.content) || assistantThinking.join("");
    const worklabResult = worklabResultFromStructuredOrMessages({
      structuredResult,
      messages: transcript,
      text: finalText,
    });
    const structuredText = finalTextFromStructured(structuredResult, worklabResult);
    const text = structuredText ?? finalText;
    const usage = usageFromMessages(transcript);
    const stopReason = lastAssistant?.stopReason || null;
    externalAbort ||= !!options.abortSignal?.aborted;
    const estimatedCost = estimateCost({
      db: options.db,
      model: reference,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedTokens: usage.cacheRead,
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
    const hadPartialProgress = !externalAbort
      && (stopReason === "error" || stopReason === "aborted")
      && (toolResultsSeen > 0 || assistantTexts.length > 0 || assistantThinking.length > 0);
    const diagnostics = {
      pi_stop_reason: stopReason,
      max_turns_hit: maxTurnsHit,
      max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
      turn_count: turnCount || assistantMessages.length || finalMessages.length,
      external_abort: externalAbort,
      ...(piErrorPayload?.code ? { pi_error_code: piErrorPayload.code } : {}),
      ...(piErrorPayload?.request_id ? { pi_request_id: piErrorPayload.request_id } : {}),
      ...(piErrorPayload ? { pi_error_payload: piErrorPayload } : {}),
      ...(hadPartialProgress ? { had_partial_progress: true, tool_results_seen: toolResultsSeen } : {}),
      ...(compaction?.diagnostics?.() || {}),
    };

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
      model: resolved.sdk === "vercel" ? resolved.reference : runtime.model.id,
      effort: options.effort || null,
      sdk: resolved.sdk,
      cancelled: externalAbort,
      error: errorMessage,
      failureKind: failureKindForPiError(errorMessage, diagnostics, { maxTurnsHit }),
      runtimeWarnings,
      diagnostics,
      ...(worklabResult ? { worklabResult, structuredResultSource: structuredResult ? "StructuredOutput" : "message" } : {}),
    };
  } catch (err) {
    externalAbort ||= !!options.abortSignal?.aborted;
    const exceptionCode = pickPiErrorCodeFromException(err);
    const errorMessage = normalizePiErrorMessage(
      piErrorPayload?.error_message || err?.message || String(err),
    );
    const hadPartialProgress = !externalAbort
      && (toolResultsSeen > 0 || assistantTexts.length > 0 || assistantThinking.length > 0);
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
      failureKind: externalAbort ? null : failureKindForPiError(errorMessage, {
        ...(compaction?.diagnostics?.() || {}),
      }, { maxTurnsHit }),
      runtimeWarnings,
      diagnostics: {
        pi_stop_reason: externalAbort ? "aborted" : "error",
        max_turns_hit: maxTurnsHit,
        max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
        turn_count: turnCount,
        external_abort: externalAbort,
        ...(piErrorPayload?.code || exceptionCode
          ? { pi_error_code: piErrorPayload?.code || exceptionCode }
          : {}),
        ...(piErrorPayload?.request_id ? { pi_request_id: piErrorPayload.request_id } : {}),
        ...(piErrorPayload ? { pi_error_payload: piErrorPayload } : {}),
        ...(hadPartialProgress ? { had_partial_progress: true, tool_results_seen: toolResultsSeen } : {}),
        ...(compaction?.diagnostics?.() || {}),
      },
    };
  } finally {
    await closePiMcpClients(mcpClients);
  }
}

export const piOpenAiBackend = {
  kind: "openai",
  capabilities: backendCapabilities("openai"),
  execute: generatePiResponse,
};

export const piCodexBackend = {
  kind: "codex",
  capabilities: backendCapabilities("codex"),
  execute: generatePiResponse,
};

export const piVercelBackend = {
  kind: "vercel",
  capabilities: backendCapabilities("vercel"),
  execute: generatePiResponse,
};

export const piGenericBackend = {
  kind: "pi",
  capabilities: backendCapabilities("pi"),
  execute: generatePiResponse,
};
