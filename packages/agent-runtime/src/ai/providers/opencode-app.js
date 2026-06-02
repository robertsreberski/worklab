import { createOpencode } from "@opencode-ai/sdk";
import { estimateCost } from "../cost.js";
import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";
import {
  toolUseEvent,
  toolResultEvent,
  thinkingEvent,
  assistantTextEvent,
  toolPartSettled,
} from "../streaming/opencode-events.js";

// OpenCode agent backend (sdk='opencode', execution_mode='cli'). Drives the local
// `opencode` server via @opencode-ai/sdk and resolves provider credentials from
// OpenCode's own auth.json (Copilot / ChatGPT / Zen / 75+ providers). Structurally
// modeled on codex-app.js, but over the SDK's HTTP + event-stream surface.
//
// Capability notes (verified against @opencode-ai/sdk 1.15.x):
//   - `session.prompt` blocks until the turn is done and returns the final message.
//   - The published SDK has NO structured-output (`format`) field, so we do not
//     enforce the worklab_result schema here; the system prompt asks for the JSON
//     and the worker's parseWorklabResultLenient recovers it (same as codex-app).
//   - No mid-turn steering primitive and no native-subagent injection in this SDK
//     revision, so supports_live_input / supports_native_subagents are false.
const OPENCODE_APP_CAPABILITIES = {
  kind: "opencode-app",
  runtime: "app-server",
  streaming: true,
  structured_output: false,
  supports_session_resume: true,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: false,
  supports_builtin_tools: true,
  supports_live_input: false,
  supports_native_subagents: false,
  supports_fast_mode: false,
};

// How long to keep draining the event stream after session.prompt resolves, in
// case the terminal session.idle event lands just after the HTTP response.
const POST_PROMPT_DRAIN_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    timer.unref?.();
  });
}

function num(value) {
  return Number.isFinite(value) ? value : null;
}

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n\n")
    : String(messages || "");
}

// hey-api RequestResult resolves to { data, error }. Surface errors as throws so
// the caller's try/catch maps them to a failure kind.
function unwrap(result) {
  if (result && typeof result === "object" && ("data" in result || "error" in result)) {
    if (result.error) {
      const message = typeof result.error === "string"
        ? result.error
        : (result.error?.message || JSON.stringify(result.error));
      throw Object.assign(new Error(message), { opencodeError: result.error });
    }
    return result.data;
  }
  return result;
}

export function opencodeMcpConfig(mcpServers = {}) {
  const out = {};
  for (const [name, cfg] of Object.entries(mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    if (cfg?.command) {
      out[name] = {
        type: "local",
        command: [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])],
        ...(cfg.env && typeof cfg.env === "object" ? { environment: cfg.env } : {}),
        enabled: true,
      };
    } else if (cfg?.url) {
      out[name] = {
        type: "remote",
        url: cfg.url,
        ...(cfg.headers && typeof cfg.headers === "object" ? { headers: cfg.headers } : {}),
        enabled: true,
      };
    }
  }
  return out;
}

function usageFromInfo(info) {
  const tokens = info?.tokens || {};
  const cache = tokens.cache || {};
  return {
    input_tokens: num(tokens.input),
    output_tokens: num(tokens.output),
    cache_read_tokens: num(cache.read),
    cache_creation_tokens: num(cache.write),
  };
}

function finalTextFromParts(parts) {
  const text = (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text")
    .map((p) => p.text || "")
    .join("")
    .trim();
  return text || null;
}

export function mapErrorFailureKind(error) {
  const name = error?.name || error?.data?.name || "";
  if (name === "MessageAbortedError") return "cancelled";
  if (name === "MessageOutputLengthError") return "usage_limit";
  return "provider_unavailable";
}

export function mapSpawnFailureKind(err) {
  const text = `${err?.code || ""} ${err?.message || ""}`.toLowerCase();
  if (/enoent|command not found|spawn/.test(text)) return "spawn";
  return "provider_unavailable";
}

async function generateOpencodeAppResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model?.sdk
    ? options.model
    : { sdk: "opencode", provider: "", model: String(options.model || "") };
  const providerID = resolved.provider;
  const modelID = resolved.model;
  const reference = resolved.reference || `opencode:${providerID}:${modelID}`;

  const events = [];
  const emit = (event) => {
    if (!event) return;
    events.push(event);
    try { options.onEvent?.(event); } catch { /* listener errors must not abort the run */ }
  };

  const mcp = opencodeMcpConfig(options.mcpServers);
  let sessionId = (typeof options.providerSessionId === "string" && options.providerSessionId)
    || (typeof options.sessionId === "string" && options.sessionId)
    || null;

  let client = null;
  let server = null;
  let usage = null;
  let errorMessage = null;
  let failureKind = null;
  let finalText = null;
  const seenToolUse = new Set();

  const abortHandler = () => {
    try { if (sessionId) client?.session?.abort?.({ path: { id: sessionId } }); } catch { /* best effort */ }
  };

  try {
    const opencode = await createOpencode({
      ...(Object.keys(mcp).length ? { config: { mcp } } : { config: {} }),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    client = opencode.client;
    server = opencode.server;
    options.abortSignal?.addEventListener?.("abort", abortHandler, { once: true });

    if (!sessionId) {
      const created = unwrap(await client.session.create({ body: {} }));
      sessionId = created?.id;
      if (!sessionId) throw new Error("opencode did not return a session id");
    }

    let pumpDone = false;

    const respondToPermission = async (perm) => {
      if (perm.sessionID && perm.sessionID !== sessionId) return;
      let decision = "once";
      if (typeof options.onToolApprovalRequest === "function") {
        try {
          const verdict = await options.onToolApprovalRequest({
            id: perm.id,
            tool: perm.type,
            title: perm.title,
            input: perm.metadata,
            riskTier: options.approvalDefaultRiskTier,
          });
          if (verdict === false || verdict?.approved === false) decision = "reject";
          else if (verdict?.always) decision = "always";
          else decision = "once";
        } catch {
          decision = "reject";
        }
      }
      try {
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: perm.id },
          body: { response: decision },
        });
      } catch { /* the turn will surface the denial on its own */ }
    };

    const handleEvent = async (event) => {
      if (!event || typeof event !== "object") return;
      const props = event.properties || {};
      switch (event.type) {
        case "message.part.updated": {
          const part = props.part;
          if (!part || (part.sessionID && part.sessionID !== sessionId)) return;
          if (part.type === "tool") {
            if (!seenToolUse.has(part.callID)) {
              seenToolUse.add(part.callID);
              emit(toolUseEvent(part));
            }
            if (toolPartSettled(part)) emit(toolResultEvent(part));
          } else if (part.type === "reasoning" && part.text) {
            emit(thinkingEvent(part));
          }
          return;
        }
        case "message.updated": {
          const info = props.info;
          if (info?.role === "assistant" && info?.tokens) usage = usageFromInfo(info);
          return;
        }
        case "permission.updated":
          await respondToPermission(props);
          return;
        case "session.error":
          if (props.sessionID && props.sessionID !== sessionId) return;
          errorMessage = props.error?.message || "opencode session error";
          failureKind = mapErrorFailureKind(props.error);
          pumpDone = true;
          return;
        case "session.idle":
          if (props.sessionID === sessionId) pumpDone = true;
          return;
        default:
          return;
      }
    };

    const subscription = await client.event.subscribe();
    const pump = (async () => {
      try {
        for await (const event of subscription.stream) {
          await handleEvent(event);
          if (pumpDone) break;
        }
      } catch { /* stream closed; teardown handles the rest */ }
    })();

    const promptResult = unwrap(await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        system: systemPrompt,
        parts: [{ type: "text", text: promptFromMessages(options.messages) }],
      },
    }));

    // Let the pump drain to the terminal session.idle (which lands around when
    // prompt resolves); don't force-stop it or in-flight tool events are lost.
    await Promise.race([pump, delay(POST_PROMPT_DRAIN_MS)]);

    const info = promptResult?.info || {};
    if (!usage) usage = usageFromInfo(info);
    if (info.error && !errorMessage) {
      errorMessage = info.error?.message || "opencode turn failed";
      failureKind = mapErrorFailureKind(info.error);
    }
    finalText = finalTextFromParts(promptResult?.parts);
    if (finalText) emit(assistantTextEvent(finalText));

    const reportedCost = num(info.cost);
    const costUsd = reportedCost !== null ? reportedCost : estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: Math.max(0, (usage?.input_tokens || 0) - (usage?.cache_read_tokens || 0)),
      outputTokens: usage?.output_tokens || 0,
      cachedTokens: usage?.cache_read_tokens || 0,
      cacheWriteTokens: usage?.cache_creation_tokens || 0,
    });

    return {
      text: finalText,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: { ...(usage || {}), cost_usd: costUsd },
      durationMs: Date.now() - start,
      numTurns: 1,
      model: reference,
      effort: options.effort || null,
      sdk: "opencode",
      providerSessionId: sessionId || null,
      provider_session_id: sessionId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind,
      diagnostics: {},
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: (usage?.cache_read_tokens || 0) > 0 || (usage?.cache_creation_tokens || 0) > 0,
        thinkingEnabled: null,
        structuredOutputEnforced: false,
        subagentInvoked: null,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } catch (err) {
    return {
      text: finalText,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: usage ? { ...usage, cost_usd: 0 } : null,
      durationMs: Date.now() - start,
      numTurns: events.length ? 1 : 0,
      model: reference,
      effort: options.effort || null,
      sdk: "opencode",
      providerSessionId: sessionId || null,
      provider_session_id: sessionId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: err?.message || String(err),
      failureKind: failureKind
        || (err?.opencodeError ? mapErrorFailureKind(err.opencodeError) : mapSpawnFailureKind(err)),
      diagnostics: { ...(events.length ? { had_partial_progress: true } : {}) },
      capabilitiesUsed: buildCapabilitiesUsed({
        structuredOutputEnforced: false,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
      }),
    };
  } finally {
    options.abortSignal?.removeEventListener?.("abort", abortHandler);
    try { server?.close?.(); } catch { /* best effort */ }
  }
}

export const opencodeAppRuntimeBridge = {
  id: "opencode-app",
  kind: "opencode-app",
  capabilities: OPENCODE_APP_CAPABILITIES,
  supports: (ref, options) => ref?.sdk === "opencode" && options?.executionMode === "cli",
  execute: generateOpencodeAppResponse,
};
