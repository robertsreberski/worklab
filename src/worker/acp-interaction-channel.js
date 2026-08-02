import { randomUUID } from "node:crypto";
import {
  normalizeAcpInteractionDispositionValue,
  sanitizeAcpInteractionSchema,
} from "../core/acp-operations.js";
import {
  createAcpUrlPublicRequest,
  inspectAcpUrlHandoff,
} from "../core/acp-url-handoff.js";
import { scanAcpPrivateValues } from "../core/acp-private-values.js";

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

/**
 * Worker-local last line of defense for ACP values that an SDK may echo to
 * stderr. URL components are registered before fd3 is written, so redaction
 * does not depend on callback ordering between the fd3 and stderr pipes.
 */
export function createAcpPrivateOutputRedactor() {
  const values = new Set();
  let totalChars = 0;
  let failedClosed = false;

  function remember(value) {
    if (failedClosed) return false;
    const scanned = scanAcpPrivateValues(value, {
      knownTokens: values,
      knownChars: totalChars,
    });
    if (!scanned.ok) {
      failedClosed = true;
      values.clear();
      totalChars = 0;
      return false;
    }
    for (const token of scanned.tokens) values.add(token);
    totalChars += scanned.chars;
    return true;
  }

  function redactText(value) {
    if (failedClosed) return "[redacted]";
    let result = String(value ?? "");
    for (const entry of [...values].sort((left, right) => right.length - left.length)) {
      result = result.split(entry).join("[redacted]");
    }
    return result;
  }

  function protectWritable(stream) {
    if (!stream || typeof stream.write !== "function") return () => {};
    const originalWrite = stream.write;
    function protectedWrite(chunk, encoding, callback) {
      const cb = typeof encoding === "function" ? encoding : callback;
      const inputEncoding = typeof encoding === "string" ? encoding : "utf8";
      const source = Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
        ? Buffer.from(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength).toString(inputEncoding)
        : String(chunk ?? "");
      const redacted = redactText(source);
      return cb
        ? originalWrite.call(stream, redacted, inputEncoding, cb)
        : originalWrite.call(stream, redacted, inputEncoding);
    }
    stream.write = protectedWrite;
    return () => {
      if (stream.write === protectedWrite) stream.write = originalWrite;
    };
  }

  return {
    remember,
    redactText,
    protectWritable,
    get failedClosed() { return failedClosed; },
  };
}

export function protectAcpPrivateOutput({ profileId, stream, redactor } = {}) {
  if (!profileId) return () => {};
  return redactor?.protectWritable?.(stream) || (() => {});
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
    ...(toolCall ? { toolCall } : {}),
    options,
  };
}

function sanitizeElicitation(payload = {}) {
  const requestedSchema = payload.requestedSchema && typeof payload.requestedSchema === "object"
    ? payload.requestedSchema
    : null;
  return {
    toolCallId: boundedText(payload.toolCallId, 1024),
    requestId: boundedText(payload.requestId, 1024),
    mode: payload.mode === "url" ? "url" : "form",
    message: boundedText(payload.message),
    elicitationId: boundedText(payload.elicitationId, 1024),
    url: payload.mode === "url" ? boundedText(payload.url, 8192) : null,
    ...(requestedSchema ? { requestedSchema } : {}),
  };
}

function rejectedResponse(kind) {
  return { response: cancelledResponse(kind), disposition: "cancel", rejected: true };
}

function normalizeResponse(entry, message) {
  if (entry.kind === "permission") {
    const outcome = message?.response?.outcome || message?.outcome;
    const outcomeKind = normalizeAcpInteractionDispositionValue(outcome?.outcome
      || message?.response?.action
      || message?.response?.disposition
      || message?.action
      || message?.disposition);
    const optionId = outcome?.optionId
      || outcome?.option_id
      || message?.response?.optionId
      || message?.response?.option_id
      || message?.optionId
      || message?.option_id;
    const disposition = normalizeAcpInteractionDispositionValue(message?.disposition || outcomeKind);
    if (outcomeKind === "cancel" && optionId == null) {
      return { response: cancelledResponse(entry.kind), disposition: "cancel", rejected: false };
    }
    if (!["selected", "allow_once", "allow_always", "reject_once", "reject_always"].includes(outcomeKind)) {
      return rejectedResponse(entry.kind);
    }
    const option = entry.offeredOptions.get(optionId);
    if (!option) return rejectedResponse(entry.kind);
    const optionKind = typeof option.kind === "string" ? option.kind.trim().toLowerCase() : "";
    if (disposition !== "selected" && disposition !== optionKind) return rejectedResponse(entry.kind);
    return {
      response: { outcome: { outcome: "selected", optionId } },
      disposition,
      rejected: false,
    };
  }

  const response = message?.response && typeof message.response === "object"
    ? message.response
    : message;
  const action = normalizeAcpInteractionDispositionValue(
    response?.action || response?.disposition || message?.disposition,
  );
  if (action === "decline" || action === "cancel") {
    return { response: { action }, disposition: action, rejected: false };
  }
  if (action !== "accept") return rejectedResponse(entry.kind);
  if (Object.prototype.hasOwnProperty.call(response, "content")) {
    return {
      response: { action: "accept", content: response.content },
      disposition: "accept",
      rejected: false,
    };
  }
  return {
    response: Object.prototype.hasOwnProperty.call(response, "values")
      ? { action: "accept", content: response.values }
      : { action: "accept" },
    disposition: "accept",
    rejected: false,
  };
}

function privateResponseValues(message) {
  const response = message?.response && typeof message.response === "object"
    ? message.response
    : message;
  return [response?.content, response?.values];
}

/**
 * Worker-side rendezvous for ACP permission and elicitation requests.
 * Submitted form values remain only in this in-memory channel and are never
 * emitted to stdout, which keeps them out of Worklab logs and persistence.
 */
export function createAcpInteractionChannel({
  emit,
  emitPrivateUrlHandoff,
  runId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idFactory = randomUUID,
  rememberPrivateValues = () => true,
} = {}) {
  const pending = new Map();
  let timeoutsEnabled = true;

  function acknowledge(interactionId, outcome, {
    deliveryId = null,
    disposition = null,
    reason = null,
  } = {}) {
    try {
      emit({
        type: "acp_interaction_acknowledged",
        interaction_id: boundedText(String(interactionId), 1024),
        outcome,
        ...(deliveryId ? { delivery_id: boundedText(String(deliveryId), 1024) } : {}),
        ...(disposition ? { disposition: boundedText(String(disposition), 128) } : {}),
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
    const normalized = normalizeResponse(entry, message);
    let privateValuesAccepted = true;
    if (!normalized.rejected) {
      try { privateValuesAccepted = rememberPrivateValues(privateResponseValues(message)); }
      catch { privateValuesAccepted = false; }
    }
    const rejected = normalized.rejected || !privateValuesAccepted;
    const response = rejected ? cancelledResponse(entry.kind) : normalized.response;
    entry.resolve(response);
    acknowledge(interactionId, rejected ? "cancelled" : "submitted", {
      deliveryId,
      disposition: rejected ? "cancel" : normalized.disposition,
      ...(rejected ? { reason: "response_rejected" } : {}),
    });
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

    const isUrl = kind === "elicitation" && request?.payload?.mode === "url";
    let privateUrl = null;
    if (isUrl) {
      privateUrl = inspectAcpUrlHandoff(request?.payload?.url);
      if (!privateUrl || !rememberPrivateValues(privateUrl.privateValues)) {
        return Promise.resolve(cancelledResponse(kind));
      }
      const frame = privateUrl ? {
        type: "worklab_acp_url_handoff",
        version: 1,
        interaction_id: String(interactionId),
        run_id: String(runId || ""),
        profile_id: String(profileId),
        url: request.payload.url,
      } : null;
      let handedOff = false;
      try {
        handedOff = Boolean(frame && runId && emitPrivateUrlHandoff?.(frame) === true);
      } catch {
        handedOff = false;
      }
      if (!handedOff) return Promise.resolve(cancelledResponse(kind));
    }

    const shaped = kind === "permission"
      ? sanitizePermission(request?.payload)
      : isUrl
        ? createAcpUrlPublicRequest(request.payload.url)
        : sanitizeElicitation(request?.payload);
    const sanitized = sanitizeAcpInteractionSchema(shaped);
    const offeredOptions = new Map(
      kind === "permission" ? sanitized.options.map((option) => [option.optionId, option]) : [],
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
          acknowledge(interactionId, "expired", { disposition: "cancel", reason: "worker_timeout" });
        }, timeoutMs);
        timer.unref?.();
      }
      const signal = context?.signal;
      const onAbort = () => cancel(interactionId, { reason: "request_aborted" });
      pending.set(interactionId, { kind, resolve, timer, offeredOptions, signal, onAbort });
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
    acknowledge(interactionId, outcome, { deliveryId, disposition: "cancel", reason });
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
    urlHandoffAvailable: typeof emitPrivateUrlHandoff === "function" && Boolean(runId),
    _disableTimeouts() { timeoutsEnabled = false; },
  };
}
