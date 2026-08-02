import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TEXT_CHARS = 16_384;

function boundedText(value, limit = MAX_TEXT_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > limit ? value.slice(0, limit) : value;
}

function cancelledResponse(kind) {
  return kind === "permission"
    ? { outcome: { outcome: "cancelled" } }
    : { action: "cancel" };
}

function sanitizePermission(payload = {}) {
  const toolCall = payload.toolCall && typeof payload.toolCall === "object"
    ? {
      toolCallId: boundedText(payload.toolCall.toolCallId, 512),
      title: boundedText(payload.toolCall.title),
      kind: boundedText(payload.toolCall.kind, 128),
      status: boundedText(payload.toolCall.status, 128),
    }
    : null;
  const options = Array.isArray(payload.options)
    ? payload.options.slice(0, 64).map((option) => ({
      optionId: boundedText(option?.optionId, 512),
      name: boundedText(option?.name),
      kind: boundedText(option?.kind, 128),
    })).filter((option) => option.optionId)
    : [];
  return {
    sessionId: boundedText(payload.sessionId, 1024),
    ...(toolCall ? { toolCall } : {}),
    options,
  };
}

function sanitizeRequestedSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  // The schema describes requested fields but carries no submitted values.
  // JSON round-tripping also prevents prototypes/functions crossing stdout.
  try {
    const text = JSON.stringify(schema);
    if (text.length > 128 * 1024) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeElicitation(payload = {}) {
  const requestedSchema = sanitizeRequestedSchema(payload.requestedSchema);
  return {
    sessionId: boundedText(payload.sessionId, 1024),
    toolCallId: boundedText(payload.toolCallId, 1024),
    requestId: boundedText(payload.requestId, 1024),
    mode: payload.mode === "url" ? "url" : "form",
    message: boundedText(payload.message),
    elicitationId: boundedText(payload.elicitationId, 1024),
    url: payload.mode === "url" ? boundedText(payload.url, 8192) : null,
    ...(requestedSchema ? { requestedSchema } : {}),
  };
}

function normalizeResponse(entry, message) {
  if (entry.kind === "permission") {
    const outcome = message?.response?.outcome || message?.outcome;
    const outcomeKind = outcome?.outcome || message?.action;
    if (outcomeKind !== "selected") return cancelledResponse(entry.kind);
    const optionId = outcome?.optionId || message?.optionId || message?.option_id;
    if (!entry.offeredOptionIds.has(optionId)) return cancelledResponse(entry.kind);
    return { outcome: { outcome: "selected", optionId } };
  }

  const response = message?.response && typeof message.response === "object"
    ? message.response
    : message;
  const action = response?.action;
  if (action === "decline" || action === "cancel") return { action };
  if (action !== "accept") return cancelledResponse(entry.kind);
  return Object.prototype.hasOwnProperty.call(response, "content")
    ? { action: "accept", content: response.content }
    : { action: "accept" };
}

/**
 * Worker-side rendezvous for ACP permission and elicitation requests.
 * Submitted form values remain only in this in-memory channel and are never
 * emitted to stdout, which keeps them out of Worklab logs and persistence.
 */
export function createAcpInteractionChannel({
  emit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idFactory = randomUUID,
} = {}) {
  const pending = new Map();
  let timeoutsEnabled = true;

  function settle(interactionId, message) {
    const entry = pending.get(interactionId);
    if (!entry) return false;
    pending.delete(interactionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(normalizeResponse(entry, message));
    return true;
  }

  function request(request, context = {}) {
    const kind = request?.kind === "permission" ? "permission" : "elicitation";
    const profileId = request?.profileId || context?.profileId;
    const interactionId = context?.requestId || idFactory();
    if (!profileId || !interactionId) return Promise.resolve(cancelledResponse(kind));

    const sanitized = kind === "permission"
      ? sanitizePermission(request?.payload)
      : sanitizeElicitation(request?.payload);
    const offeredOptionIds = new Set(
      kind === "permission" ? sanitized.options.map((option) => option.optionId) : [],
    );

    return new Promise((resolve) => {
      let timer = null;
      if (timeoutsEnabled && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.delete(interactionId)) resolve(cancelledResponse(kind));
        }, timeoutMs);
        timer.unref?.();
      }
      pending.set(interactionId, { kind, resolve, timer, offeredOptionIds });
      try {
        emit({
          type: "acp_interaction_requested",
          interaction_id: interactionId,
          profile_id: profileId,
          interaction_kind: kind,
          request: sanitized,
          ts: Date.now(),
        });
      } catch {
        if (pending.delete(interactionId) && timer) clearTimeout(timer);
        resolve(cancelledResponse(kind));
      }
    });
  }

  function acceptResponse(message) {
    if (!message || typeof message !== "object") return false;
    const interactionId = message.interaction_id || message.interactionId;
    return interactionId ? settle(interactionId, message) : false;
  }

  function cancel(interactionId) {
    const entry = pending.get(interactionId);
    if (!entry) return false;
    pending.delete(interactionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(cancelledResponse(entry.kind));
    return true;
  }

  function cancelAllPending() {
    for (const interactionId of [...pending.keys()]) cancel(interactionId);
  }

  return {
    request,
    acceptResponse,
    cancel,
    cancelAllPending,
    pendingCount: () => pending.size,
    _disableTimeouts() { timeoutsEnabled = false; },
  };
}

