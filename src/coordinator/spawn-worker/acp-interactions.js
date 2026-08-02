import { randomUUID } from "node:crypto";

import {
  acpInteractionDisposition,
  normalizeAcpInteractionDispositionValue,
  rowToAcpInteraction,
  sanitizeAcpInteractionSchema,
} from "../../core/acp-operations.js";
import {
  createAcpEventPrivacyBoundary,
  validateAcpProviderSessionId,
} from "../../core/acp-privacy.js";
import {
  cancelAcpInteraction,
  claimAcpInteractionResponse,
  expirePendingAcpInteractionsForRun,
  finalizeAcpInteractionResponse,
  getAcpInteractionById,
  insertAcpInteractionRequest,
} from "../../core/db/queries/acp-interactions.js";
import {
  createAcpUrlPublicRequest,
  inspectAcpUrlHandoff,
} from "../../core/acp-url-handoff.js";
import { scanAcpPrivateValues } from "../../core/acp-private-values.js";

const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const TERMINAL_OUTCOMES = new Set(["submitted", "cancelled", "expired", "stale"]);
const TERMINAL_REASONS = new Set([
  "worker_timeout",
  "request_aborted",
  "client_cancelled",
  "coordinator_shutdown",
  "run_aborted",
  "run_terminated",
  "worker_terminated",
  "not_pending",
  "response_rejected",
]);
const ACKNOWLEDGED_DISPOSITIONS = new Set([
  "accept",
  "decline",
  "cancel",
  "selected",
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
const ACP_URL_HANDOFF_FRAME_TYPE = "worklab_acp_url_handoff";
const ACP_URL_HANDOFF_FRAME_VERSION = 1;
const MAX_URL_HANDOFF_FRAME_BYTES = 16 * 1024;
const DEFAULT_URL_HANDOFF_WAIT_MS = 250;

function exactIdentifier(value, max = 1024) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

export function taskRunEventNeedsUrlHandoff(event) {
  return event?.type === "acp_interaction_requested"
    && event?.interaction_kind !== "permission"
    && event?.request?.mode === "url";
}

/**
 * Consume the worker's dedicated fd3 stream. Raw frames never pass through an
 * event object or logger; failures are reported only as fixed reason codes.
 */
export function createTaskRunAcpUrlHandoffReceiver({
  stream,
  store,
  runId,
  profileId,
  onInvalid,
  onRetained,
  waitMs = DEFAULT_URL_HANDOFF_WAIT_MS,
} = {}) {
  const owner = {
    ownerKind: "run",
    ownerId: exactIdentifier(runId),
    profileId: exactIdentifier(profileId),
  };
  const waiters = new Map();
  let buffer = Buffer.alloc(0);
  let closed = !stream || !store || !owner.ownerId || !owner.profileId;

  function report(code) {
    try { onInvalid?.(code); } catch { /* diagnostics must not break the pipe */ }
  }

  function settleWaiters(interactionId, result) {
    const entries = waiters.get(interactionId) || [];
    waiters.delete(interactionId);
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(result);
    }
  }

  function rejectChannel(code) {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    for (const interactionId of waiters.keys()) settleWaiters(interactionId, false);
    report(code);
    stream?.destroy?.();
  }

  function acceptLine(line) {
    if (line.length === 0) return;
    if (line.length > MAX_URL_HANDOFF_FRAME_BYTES) {
      rejectChannel("frame_too_large");
      return;
    }
    let frame;
    try {
      frame = JSON.parse(line.toString("utf8"));
    } catch {
      rejectChannel("frame_invalid");
      return;
    }
    const expectedKeys = ["interaction_id", "profile_id", "run_id", "type", "url", "version"];
    const inspected = inspectAcpUrlHandoff(frame?.url);
    if (!frame
      || typeof frame !== "object"
      || Array.isArray(frame)
      || Object.keys(frame).sort().join("\0") !== expectedKeys.join("\0")
      || frame.type !== ACP_URL_HANDOFF_FRAME_TYPE
      || frame.version !== ACP_URL_HANDOFF_FRAME_VERSION
      || frame.run_id !== owner.ownerId
      || frame.profile_id !== owner.profileId
      || !exactIdentifier(frame.interaction_id)
      || !inspected) {
      rejectChannel("frame_invalid");
      return;
    }
    const interactionId = frame.interaction_id;
    let retained = store.retain({
      interactionId,
      ...owner,
      url: frame.url,
    }) === true;
    if (retained && typeof onRetained === "function") {
      try {
        retained = onRetained({ interactionId, url: frame.url }) === true;
      } catch {
        retained = false;
      }
      if (!retained) store.remove(interactionId, owner);
    }
    settleWaiters(interactionId, retained);
    if (!retained) report("frame_rejected");
  }

  function onData(chunk) {
    if (closed) return;
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length + next.length > MAX_URL_HANDOFF_FRAME_BYTES && !next.includes(0x0a)) {
      rejectChannel("frame_too_large");
      return;
    }
    buffer = Buffer.concat([buffer, next]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      acceptLine(line);
      if (closed) return;
    }
    if (buffer.length > MAX_URL_HANDOFF_FRAME_BYTES) rejectChannel("frame_too_large");
  }

  function close() {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    for (const interactionId of waiters.keys()) settleWaiters(interactionId, false);
    stream?.off?.("data", onData);
    stream?.off?.("end", onEnd);
    stream?.off?.("error", onError);
  }

  function onEnd() {
    if (buffer.length > 0) report("frame_incomplete");
    close();
  }

  function onError() {
    report("channel_error");
    close();
  }

  if (!closed) {
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  }

  function waitFor(interactionId) {
    const interaction = exactIdentifier(interactionId);
    if (!interaction || closed) return Promise.resolve(false);
    if (store.has({ interactionId: interaction, ...owner })) return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const pending = waiters.get(interaction) || [];
        waiters.set(interaction, pending.filter((candidate) => candidate !== entry));
        if (waiters.get(interaction)?.length === 0) waiters.delete(interaction);
        resolve(false);
      }, Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_URL_HANDOFF_WAIT_MS);
      entry.timer.unref?.();
      const pending = waiters.get(interaction) || [];
      pending.push(entry);
      waiters.set(interaction, pending);
      // The frame can arrive between the first has() check and waiter insert.
      if (store.has({ interactionId: interaction, ...owner })) settleWaiters(interaction, true);
    });
  }

  return {
    available: !closed,
    waitFor,
    close,
  };
}

function boundedIdentifier(value, max = 1024) {
  if (value == null) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, max);
}

function acpPrivacyBoundaryFailure(event) {
  return {
    type: "worklab_result_error",
    message: "ACP worker event rejected by the task-run privacy boundary",
    diagnostics: { acp_event_redaction_failed: true },
    ts: Date.now(),
    ...(Number.isFinite(Number(event?._event_seq)) ? { _event_seq: Number(event._event_seq) } : {}),
  };
}

export function createTaskRunAcpEventBoundary({ profileId } = {}) {
  const boundary = createAcpEventPrivacyBoundary({
    profileId,
    failureValue: acpPrivacyBoundaryFailure,
  });
  return {
    sanitizeWorkerEvent: boundary.sanitizeEvent,
    redactText: boundary.redactText,
    validateProviderSessionId: (value) => (
      profileId
        ? validateAcpProviderSessionId(value, profileId)
        : typeof value === "string" && value.length > 0 ? value : null
    ),
    get failedClosed() { return boundary.failedClosed; },
  };
}

function stripAcpSessionIdentifiers(value, depth = 0) {
  if (depth > 20) return null;
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => stripAcpSessionIdentifiers(entry, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    key === "sessionId" || key === "session_id"
      ? []
      : [[key, stripAcpSessionIdentifiers(entry, depth + 1)]]
  )));
}

export function sanitizeTaskRunAcpInteractionEvent(event, { urlPublicRequest = null } = {}) {
  if (event?.type === "acp_session_update") {
    return stripAcpSessionIdentifiers(event);
  }
  if (event?.type === "sdk_event" && event.event?.type === "acp_session_update") {
    return { ...event, event: stripAcpSessionIdentifiers(event.event) };
  }
  if (!event || !String(event.type || "").startsWith("acp_interaction_")) return event;
  if (event.type === "acp_interaction_requested") {
    const request = event?.request?.mode === "url" && urlPublicRequest
      ? urlPublicRequest
      : event.request;
    return {
      type: "acp_interaction_requested",
      interaction_id: boundedIdentifier(event.interaction_id),
      protocol_request_id: boundedIdentifier(event.protocol_request_id || event.interaction_id),
      profile_id: boundedIdentifier(event.profile_id),
      interaction_kind: event.interaction_kind === "permission" ? "permission" : "elicitation",
      request: sanitizeAcpInteractionSchema(request),
      ts: Number(event.ts) || Date.now(),
      ...(Number.isFinite(Number(event._event_seq)) ? { _event_seq: Number(event._event_seq) } : {}),
    };
  }
  if (event.type === "acp_interaction_acknowledged") {
    const disposition = normalizeAcpInteractionDispositionValue(event.disposition);
    return {
      type: "acp_interaction_acknowledged",
      interaction_id: boundedIdentifier(event.interaction_id),
      outcome: TERMINAL_OUTCOMES.has(event.outcome) ? event.outcome : "stale",
      ...(event.delivery_id ? { delivery_id: boundedIdentifier(event.delivery_id) } : {}),
      ...(ACKNOWLEDGED_DISPOSITIONS.has(disposition)
        ? { disposition }
        : {}),
      ...(TERMINAL_REASONS.has(event.reason) ? { reason: event.reason } : {}),
      ts: Number(event.ts) || Date.now(),
      ...(Number.isFinite(Number(event._event_seq)) ? { _event_seq: Number(event._event_seq) } : {}),
    };
  }
  return {
    type: boundedIdentifier(event.type, 128),
    interaction_id: boundedIdentifier(event.interaction_id),
    ts: Number(event.ts) || Date.now(),
    ...(Number.isFinite(Number(event._event_seq)) ? { _event_seq: Number(event._event_seq) } : {}),
  };
}

export function persistAcpInteractionRequest(db, runId, event, { profileId = null } = {}) {
  const safeEvent = sanitizeTaskRunAcpInteractionEvent(event);
  if (profileId && safeEvent.profile_id !== profileId) {
    throw new Error("ACP interaction profile does not match the active run");
  }
  const request = safeEvent.request;
  const kind = safeEvent.interaction_kind === "permission"
    ? "permission"
    : request.mode === "url" ? "url" : "form";
  const at = Number(safeEvent.ts) || Date.now();
  insertAcpInteractionRequest(db, {
    id: safeEvent.interaction_id,
    profileId: profileId || safeEvent.profile_id,
    taskRunId: runId,
    protocolRequestId: safeEvent.protocol_request_id,
    kind,
    requestSchemaJson: JSON.stringify(request),
    createdAt: at,
    updatedAt: at,
  });
}

function permissionOptionId(response) {
  const nested = response?.outcome && typeof response.outcome === "object"
    ? response.outcome
    : null;
  return nested?.optionId || nested?.option_id || response?.optionId || response?.option_id || null;
}

function permissionResponseMatchesOffer(row, response, disposition) {
  if (row.kind !== "permission") return true;
  const selected = permissionOptionId(response);
  if (disposition === "cancel") return selected == null;
  let schema = {};
  try { schema = JSON.parse(row.request_schema_json || "{}"); } catch { /* invalid rows fail closed below */ }
  const offered = new Map((Array.isArray(schema.options) ? schema.options : [])
    .map((option) => [option?.optionId || option?.id, option])
    .filter(([optionId]) => typeof optionId === "string" && optionId.length > 0));
  const option = typeof selected === "string" ? offered.get(selected) : null;
  if (!option) return false;
  const optionKind = typeof option.kind === "string" ? option.kind.trim().toLowerCase() : "";
  return disposition === "selected" || disposition === optionKind;
}

function expireInteraction(db, interactionId, disposition, now = Date.now()) {
  const info = db.prepare(`
    UPDATE acp_interactions
    SET state = 'expired', disposition = ?, updated_at = ?, resolved_at = ?
    WHERE id = ? AND state = 'pending'
  `).run(disposition, now, now, interactionId);
  return info.changes === 1 ? getAcpInteractionById(db, interactionId) : null;
}

export function createAcpInteractionControls({
  db,
  runId,
  writeControlMessage,
  emitEvent,
  idFactory = randomUUID,
  ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  urlHandoffStore = null,
} = {}) {
  const deliveries = new Map();
  const activeByInteraction = new Map();
  const privateValues = new Set();
  const privateValueTokens = new Set();
  let privateValueChars = 0;
  const urlPublicRequests = new Map();

  function rememberPrivateValues(value) {
    const scanned = scanAcpPrivateValues(value, {
      knownTokens: privateValueTokens,
      knownChars: privateValueChars,
    });
    if (!scanned.ok) return false;
    for (const value of scanned.values) privateValues.add(value);
    for (const token of scanned.tokens) privateValueTokens.add(token);
    privateValueChars += scanned.chars;
    return true;
  }

  function rememberPrivateResponse(response) {
    return rememberPrivateValues([response?.content, response?.values]);
  }

  function registerUrlHandoff({ interactionId, url } = {}) {
    const id = exactIdentifier(interactionId);
    const inspected = inspectAcpUrlHandoff(url);
    const publicRequest = createAcpUrlPublicRequest(url);
    if (!id || !inspected || !publicRequest
      || !rememberPrivateValues(inspected.privateValues)) return false;
    urlPublicRequests.set(id, publicRequest);
    return true;
  }

  function publicUrlRequest(interactionId) {
    return urlPublicRequests.get(exactIdentifier(interactionId)) || null;
  }

  function redactText(value) {
    let result = String(value ?? "");
    for (const token of [...privateValueTokens].sort((left, right) => right.length - left.length)) {
      result = result.split(token).join("[redacted]");
    }
    return result;
  }

  function redactWorkerEvent(value, depth = 0) {
    if (depth > 20) return null;
    if (value == null) return value;
    if (typeof value === "boolean" || typeof value === "number") {
      return privateValues.has(value) ? "[redacted]" : value;
    }
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map((entry) => redactWorkerEvent(entry, depth + 1));
    if (typeof value !== "object") return null;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactText(key),
      redactWorkerEvent(entry, depth + 1),
    ]));
  }

  function cleanupDelivery(delivery) {
    if (!delivery) return;
    if (delivery.timer) clearTimeout(delivery.timer);
    if (activeByInteraction.get(delivery.interactionId) === delivery.deliveryId) {
      activeByInteraction.delete(delivery.interactionId);
    }
    deliveries.delete(delivery.deliveryId);
  }

  function finishDelivery(delivery, result, { uncertain = false } = {}) {
    if (!delivery || delivery.finished) return;
    delivery.finished = true;
    if (delivery.timer) clearTimeout(delivery.timer);
    if (!uncertain) cleanupDelivery(delivery);
    delivery.resolve(result);
  }

  function beginDelivery({ interactionId, action, disposition }) {
    if (activeByInteraction.has(interactionId)) return null;
    const deliveryId = boundedIdentifier(idFactory(), 1024);
    if (!deliveryId) return null;
    let resolveAck;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    const delivery = {
      deliveryId,
      interactionId,
      action,
      disposition,
      resolve: resolveAck,
      ack,
      finished: false,
      timer: null,
    };
    if (Number.isFinite(ackTimeoutMs) && ackTimeoutMs > 0) {
      delivery.timer = setTimeout(() => {
        finishDelivery(delivery, {
          ok: false,
          code: "ack_timeout",
          message: "worker did not acknowledge the ACP interaction",
        }, { uncertain: true });
      }, ackTimeoutMs);
      delivery.timer.unref?.();
    }
    deliveries.set(deliveryId, delivery);
    activeByInteraction.set(interactionId, deliveryId);
    return delivery;
  }

  function discardDelivery(delivery) {
    if (!delivery) return;
    finishDelivery(delivery, {
      ok: false,
      code: "delivery_failed",
      message: "failed to deliver ACP interaction control message",
    });
  }

  function resultForTerminalEvent(event) {
    const interactionId = boundedIdentifier(event.interaction_id);
    const outcome = TERMINAL_OUTCOMES.has(event.outcome) ? event.outcome : "stale";
    const deliveryId = boundedIdentifier(event.delivery_id);
    const delivery = deliveryId
      ? deliveries.get(deliveryId)
      : deliveries.get(activeByInteraction.get(interactionId));
    if (delivery && delivery.interactionId !== interactionId) return null;

    let row = getAcpInteractionById(db, interactionId);
    if (!row || row.task_run_id !== runId) {
      if (delivery) finishDelivery(delivery, {
        ok: false,
        code: "no_pending_interaction",
        message: "ACP interaction is not pending for this run",
      });
      return null;
    }

    const acknowledgedDisposition = normalizeAcpInteractionDispositionValue(event.disposition);
    if (outcome === "submitted" && delivery?.action === "respond") {
      const claimed = claimAcpInteractionResponse(db, interactionId, {
        disposition: ACKNOWLEDGED_DISPOSITIONS.has(acknowledgedDisposition)
          ? acknowledgedDisposition
          : delivery.disposition,
      });
      row = claimed ? finalizeAcpInteractionResponse(db, interactionId) : null;
    } else if (outcome === "cancelled") {
      row = cancelAcpInteraction(db, interactionId, { disposition: "cancel" });
    } else if (outcome === "expired" || outcome === "stale") {
      row = expireInteraction(db, interactionId, outcome === "expired" ? "worker_timeout" : "worker_stale");
    } else {
      row = null;
    }

    const accepted = Boolean(row);
    if (accepted) {
      urlPublicRequests.delete(interactionId);
      urlHandoffStore?.remove?.(interactionId, {
        ownerKind: "run",
        ownerId: runId,
        profileId: row.profile_id,
      });
      emitEvent({
        type: "acp_interaction_resolved",
        interaction_id: interactionId,
        interaction_kind: row.kind,
        disposition: row.disposition,
        state: row.state,
        ts: Date.now(),
      });
    }
    if (delivery) {
      cleanupDelivery(delivery);
      finishDelivery(delivery, accepted
        ? { ok: true, row }
        : {
            ok: false,
            code: "no_pending_interaction",
            message: "ACP interaction is no longer pending",
          });
    }
    return row;
  }

  async function deliver({ interactionId, response, disposition, action }) {
    const existing = interactionId ? getAcpInteractionById(db, interactionId) : null;
    if (!existing || existing.task_run_id !== runId || existing.state !== "pending") {
      return { ok: false, code: "no_pending_interaction", message: "ACP interaction is not pending for this run" };
    }
    let safeDisposition = disposition;
    if (action === "respond") {
      try {
        safeDisposition = acpInteractionDisposition(rowToAcpInteraction(existing), response, disposition);
      } catch {
        return {
          ok: false,
          code: "invalid_response",
          message: "interaction response disposition is invalid",
        };
      }
    }
    if (action === "respond" && !permissionResponseMatchesOffer(existing, response, safeDisposition)) {
      return {
        ok: false,
        code: "invalid_response",
        message: "permission response does not match an offered option",
      };
    }
    if (action === "respond" && !rememberPrivateResponse(response)) {
      return { ok: false, code: "invalid_response", message: "private response exceeds safety limits" };
    }
    const delivery = beginDelivery({ interactionId, action, disposition: safeDisposition });
    if (!delivery) {
      return { ok: false, code: "delivery_in_progress", message: "ACP interaction delivery is already in progress" };
    }
    const message = action === "respond"
      ? {
          type: "acp_interaction_response",
          interaction_id: interactionId,
          delivery_id: delivery.deliveryId,
          disposition: safeDisposition,
          response,
        }
      : {
          type: "acp_interaction_cancel",
          interaction_id: interactionId,
          delivery_id: delivery.deliveryId,
        };
    try {
      await writeControlMessage(message);
    } catch (error) {
      discardDelivery(delivery);
      return {
        ok: false,
        code: "delivery_failed",
        message: error?.message || "failed to deliver ACP interaction control message",
      };
    }
    return delivery.ack;
  }

  function respond({ interactionId, response, disposition } = {}) {
    return deliver({ interactionId, response, disposition, action: "respond" });
  }

  function cancel({ interactionId } = {}) {
    return deliver({ interactionId, disposition: "cancel", action: "cancel" });
  }

  function handleWorkerEvent(event) {
    if (event?.type !== "acp_interaction_acknowledged" || !event.interaction_id) return null;
    return resultForTerminalEvent(event);
  }

  function close() {
    for (const delivery of deliveries.values()) {
      if (delivery.finished) {
        cleanupDelivery(delivery);
      } else {
        finishDelivery(delivery, {
          ok: false,
          code: "run_not_active",
          message: "run is no longer active",
        });
      }
    }
    deliveries.clear();
    activeByInteraction.clear();
    privateValues.clear();
    privateValueTokens.clear();
    privateValueChars = 0;
    urlPublicRequests.clear();
    urlHandoffStore?.removeOwner?.("run", runId);
  }

  return {
    respond,
    cancel,
    handleWorkerEvent,
    registerUrlHandoff,
    publicUrlRequest,
    redactText,
    redactWorkerEvent,
    close,
  };
}

export function expireAcpInteractionsForRun(db, runId, { urlHandoffStore = null } = {}) {
  urlHandoffStore?.removeOwner?.("run", runId);
  return expirePendingAcpInteractionsForRun(db, runId, { disposition: "run_ended" });
}
