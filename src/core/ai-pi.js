import { Agent } from "@mariozechner/pi-agent-core";
import { getModel as getPiModel } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
import { estimateCost } from "./cost.js";
import { backendCapabilities } from "./backend.js";
import { formatLiveInputGuidance } from "./live-input.js";
import {
  buildModelCapabilities,
  getModelByProviderAndName,
  getProvider,
  isPrivateBaseUrl,
  resolveReasoningCapabilities,
} from "./providers.js";
import { resolvePiApiKey } from "./pi-oauth.js";
import {
  closePiMcpClients,
  createStructuredOutputTool,
  getPiBuiltinTools,
  initPiMcpTools,
} from "./ai-pi-tools.js";
import { extractWorklabResult, formatWorklabResultText } from "./worklab-result.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const SDK_PI_PROVIDERS = {
  openai: "openai",
  codex: "openai-codex",
};

function rootUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
}

function openAiCompatBaseUrl(provider) {
  const baseUrl = String(provider?.base_url || "").replace(/\/+$/, "");
  if (provider?.provider_type === "ollama") return `${rootUrl(baseUrl)}/v1`;
  return /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function customProviderName(provider) {
  return `worklab-${provider.id}`;
}

function customProviderKey(provider) {
  if (provider?.api_key) return provider.api_key;
  return isPrivateBaseUrl(provider?.base_url) ? "ollama" : "";
}

function customCompat(provider, capabilities) {
  const local = isPrivateBaseUrl(provider?.base_url);
  return {
    supportsStore: false,
    supportsDeveloperRole: !local,
    supportsReasoningEffort: capabilities?.reasoning_mode === "effort",
    maxTokensField: "max_tokens",
  };
}

function resolveCustomPiModel(resolved, options) {
  const provider = getProvider({
    db: options.db,
    dataDir: options.dataDir,
    id: resolved.providerId,
    includeKey: true,
  });
  if (!provider) throw new Error(`provider not found: ${resolved.providerId}`);
  if (!provider.enabled) throw new Error(`provider disabled: ${resolved.providerId}`);
  const modelRow = getModelByProviderAndName({
    db: options.db,
    providerId: resolved.providerId,
    modelName: resolved.modelName,
  });
  if (modelRow && !modelRow.enabled) throw new Error(`model disabled: ${resolved.modelName}`);

  const capabilities = modelRow
    ? buildModelCapabilities(provider.provider_type, resolved.modelName, modelRow.capabilities)
    : resolveReasoningCapabilities(provider.provider_type, resolved.modelName, {});
  const providerName = customProviderName(provider);
  const pricing = modelRow?.pricing || {};
  return {
    model: {
      id: resolved.modelName,
      name: modelRow?.display_name || resolved.modelName,
      api: "openai-completions",
      provider: providerName,
      baseUrl: openAiCompatBaseUrl(provider),
      reasoning: !!capabilities.reasoning,
      input: capabilities.vision === false ? ["text"] : ["text", "image"],
      cost: {
        input: Number(pricing.input_per_million) || 0,
        output: Number(pricing.output_per_million) || 0,
        cacheRead: Number(pricing.cached_input_per_million) || 0,
        cacheWrite: 0,
      },
      contextWindow: Number(capabilities.context_window || capabilities.num_ctx) || 128000,
      maxTokens: Number(capabilities.max_tokens) || 16384,
      compat: customCompat(provider, capabilities),
    },
    capabilities,
    apiKeys: new Map([[providerName, customProviderKey(provider)]]),
  };
}

function resolvePiRuntimeModel(resolved, options) {
  if (resolved.sdk === "vercel") return resolveCustomPiModel(resolved, options);
  const provider = resolved.sdk === "pi" ? resolved.provider : SDK_PI_PROVIDERS[resolved.sdk];
  if (!provider) throw new Error(`unsupported pi sdk: ${resolved.sdk}`);
  const model = getPiModel(provider, resolved.model);
  return {
    model,
    capabilities: {
      tool_use: true,
      reasoning: !!model.reasoning,
      reasoning_mode: model.reasoning ? "effort" : "none",
      reasoning_levels: model.reasoning ? ["none", "low", "medium", "high", "xhigh"] : undefined,
      reasoning_disable_supported: true,
      vision: Array.isArray(model.input) ? model.input.includes("image") : false,
      json_mode: true,
    },
    apiKeys: new Map(),
  };
}

function promptTextFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  return messages
    .filter((message) => message?.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
    .join("\n");
}

function messageContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return { type: "text", text: part };
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
      if (part?.type === "image" && part.data) return { type: "image", data: part.data, mimeType: part.mimeType || part.mime_type || "image/png" };
      return { type: "text", text: JSON.stringify(part ?? "") };
    });
  }
  return String(value ?? "");
}

function toAgentMessages(messages, model) {
  const source = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: "" }];
  return source.flatMap((message) => {
    const timestamp = message.timestamp || Date.now();
    if (message.role === "user") return [{ role: "user", content: messageContent(message.content), timestamp }];
    if (message.role === "assistant") {
      return [{
        role: "assistant",
        content: [{ type: "text", text: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp,
      }];
    }
    if (message.role === "toolResult") return [message];
    return [];
  });
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function thinkingFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("");
}

function toolResultContent(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.type === "text" ? block.text || "" : JSON.stringify(block)).filter(Boolean).join("\n");
}

function streamContentKey(streamEvent, fallback) {
  return streamEvent?.contentIndex ?? fallback;
}

function jsonSerializable(value, fallback = null) {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return fallback;
  }
}

function emitCaptured(events, onEvent, event) {
  if (!event) return;
  events.push(event);
  onEvent?.(event);
}

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
  let cancelled = false;
  let maxTurnsHit = false;
  let turnCount = 0;

  const onEvent = (event) => emitCaptured(events, options.onEvent, event);

  try {
    const runtime = resolvePiRuntimeModel(resolved, options);
    const capabilities = runtime.capabilities || {};
    const builtIns = capabilities.tool_use === false
      ? []
      : getPiBuiltinTools(options.allowedTools, {
        skillNames: (options.skills || []).map((skill) => skill.name),
        dataDir: options.dataDir,
        cwd: options.cwd,
        onEvent,
      });

    const structuredTool = createStructuredOutputTool(options.outputSchema, (value) => {
      structuredResult = value;
    });
    const reservedNames = new Set(builtIns.map((toolDef) => toolDef.name));
    if (structuredTool) reservedNames.add(structuredTool.name);
    const mcpInit = capabilities.tool_use === false
      ? { clients: [], tools: [], warnings: [] }
      : await initPiMcpTools(options.mcpServers || {}, reservedNames);
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
        onEvent({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input: event.args || {} }] },
        });
      } else if (event.type === "tool_execution_update") {
        onEvent({
          type: "tool_update",
          tool_use_id: event.toolCallId,
          name: event.toolName,
          input: event.args || {},
          partial_result: jsonSerializable(event.partialResult, String(event.partialResult ?? "")),
        });
      } else if (event.type === "tool_execution_end") {
        const resultContent = toolResultContent(event.result);
        onEvent({
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: event.toolCallId,
              content: resultContent,
              raw_result: jsonSerializable(event.result, resultContent),
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
      cancelled = true;
      agent.abort();
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortHandler();
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
    const reference = resolved.reference
      || (resolved.sdk === "pi" ? `pi:${resolved.provider}:${resolved.model}` : `${resolved.sdk}:${resolved.model}`);
    const estimatedCost = estimateCost({
      db: options.db,
      model: reference,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedTokens: usage.cacheRead,
    });
    const rawErrorMessage = maxTurnsHit
      ? "Pi agent stopped before final output: max turns reached"
      : (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted" ? lastAssistant.errorMessage || agent.state.errorMessage : null);
    const errorMessage = normalizePiErrorMessage(rawErrorMessage);
    cancelled ||= !!options.abortSignal?.aborted || lastAssistant?.stopReason === "aborted";

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
      cancelled,
      error: errorMessage,
      failureKind: errorMessage ? (maxTurnsHit || isContextLimitError(errorMessage) ? "usage_limit" : "provider_unavailable") : null,
      runtimeWarnings,
      ...(worklabResult ? { worklabResult, structuredResultSource: structuredResult ? "StructuredOutput" : "message" } : {}),
    };
  } catch (err) {
    const errorMessage = normalizePiErrorMessage(err?.message || String(err));
    return {
      text: assistantTexts.join("") || null,
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: turnCount,
      model: resolved?.reference || resolved?.model || null,
      effort: options.effort || null,
      sdk: resolved?.sdk || "pi",
      cancelled: cancelled || !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind: isContextLimitError(errorMessage) ? "usage_limit" : "provider_unavailable",
      runtimeWarnings,
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
