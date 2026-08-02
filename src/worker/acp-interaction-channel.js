import { randomUUID } from "node:crypto";
import { sanitizeAcpInteractionSchema } from "../core/acp-operations.js";

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

function sanitizeElicitation(payload = {}) {
  const requestedSchema = payload.requestedSchema && typeof payload.requestedSchema === "object"
    ? payload.requestedSchema
    : null;
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
    const outcomeKind = outcome?.outcome
      || message?.response?.action
      || message?.response?.disposition
      || message?.action
      || message?.disposition;
    const optionId = outcome?.optionId
      || outcome?.option_id
      || message?.response?.optionId
      || message?.response?.option_id
      || message?.optionId
      || message?.option_id;
    if (!["selected", "allow_once", "allow_always", "reject_once", "reject_always"].includes(outcomeKind)) {
      return cancelledResponse(entry.kind);
    }
    if (!entry.offeredOptionIds.has(optionId)) return cancelledResponse(entry.kind);
    return { outcome: { outcome: "selected", optionId } };
  }

  const response = message?.response && typeof message.response === "object"
    ? message.response
    : message;
  const action = response?.action || response?.disposition;
  if (action === "decline" || action === "cancel") return { action };
  if (action !== "accept") return cancelledResponse(entry.kind);
  if (Object.prototype.hasOwnProperty.call(response, "content")) {
    return { action: "accept", content: response.content };
  }
  return Object.prototype.hasOwnProperty.call(response, "values")
    ? { action: "accept", content: response.values }
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

  function acknowledge(interactionId, outcome, {
    deliveryId = null,
    reason = null,
  } = {}) {
    try {
      emit({
        type: "acp_interaction_acknowledged",
        interaction_id: boundedText(String(interactionId), 1024),
        outcome,
        ...(deliveryId ? { delivery_id: boundedText(String(deliveryId), 1024) } : {}),
        ...(reason ? { reason: boundedText(String(reason), 128) } : {}),
        ts: Date.now(),
      });
    } catch {
      // The ACP callback still needs to fail closed if stdout has gone away.
    }
  }

  function settle(interactionId, message, { deliveryId = null } = {}) {
    const entry = pending.get(interactionId);
    if (!entry) {
      acknowledge(interactionId, "stale", { deliveryId, reason: "not_pending" });
      return false;
    }
    pending.delete(interactionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.resolve(normalizeResponse(entry, message));
    acknowledge(interactionId, "submitted", { deliveryId });
    return true;
  }

  function request(request, context = {}) {
    const kind = request?.kind === "permission" ? "permission" : "elicitation";
    const profileId = request?.profileId || context?.profileId;
    const interactionId = idFactory();
    const protocolRequestId = context?.requestId == null
      ? interactionId
      : boundedText(String(context.requestId), 1024);
    if (!profileId || !interactionId) return Promise.resolve(cancelledResponse(kind));

    const shaped = kind === "permission"
      ? sanitizePermission(request?.payload)
      : sanitizeElicitation(request?.payload);
    const sanitized = sanitizeAcpInteractionSchema(shaped);
    const offeredOptionIds = new Set(
      kind === "permission" ? sanitized.options.map((option) => option.optionId) : [],
    );

    return new Promise((resolve) => {
      let timer = null;
      if (timeoutsEnabled && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = pending.get(interactionId);
          if (!entry) return;
          pending.delete(interactionId);
          entry.signal?.removeEventListener("abort", entry.onAbort);
          resolve(cancelledResponse(kind));
          acknowledge(interactionId, "expired", { reason: "worker_timeout" });
        }, timeoutMs);
        timer.unref?.();
      }
      const signal = context?.signal;
      const onAbort = () => cancel(interactionId, { reason: "request_aborted" });
      pending.set(interactionId, { kind, resolve, timer, offeredOptionIds, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        emit({
          type: "acp_interaction_requested",
          interaction_id: interactionId,
          protocol_request_id: protocolRequestId,
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
    const deliveryId = message.delivery_id || message.deliveryId || null;
    return interactionId ? settle(interactionId, message, { deliveryId }) : false;
  }

  function cancel(interactionId, {
    deliveryId = null,
    reason = "cancelled",
    outcome = "cancelled",
  } = {}) {
    const entry = pending.get(interactionId);
    if (!entry) {
      acknowledge(interactionId, "stale", { deliveryId, reason: "not_pending" });
      return false;
    }
    pending.delete(interactionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.resolve(cancelledResponse(entry.kind));
    acknowledge(interactionId, outcome, { deliveryId, reason });
    return true;
  }

  function cancelAllPending(reason = "worker_terminated") {
    for (const interactionId of [...pending.keys()]) cancel(interactionId, { reason });
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
