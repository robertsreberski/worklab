import { randomUUID } from "node:crypto";

import { sanitizeAcpInteractionSchema } from "../../core/acp-operations.js";
import {
  cancelAcpInteraction,
  claimAcpInteractionResponse,
  expirePendingAcpInteractionsForRun,
  finalizeAcpInteractionResponse,
  getAcpInteractionById,
  insertAcpInteractionRequest,
} from "../../core/db/queries/acp-interactions.js";

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
]);
const MAX_PRIVATE_VALUES = 10_000;

function boundedIdentifier(value, max = 1024) {
  if (value == null) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, max);
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

export function sanitizeTaskRunAcpInteractionEvent(event) {
  if (event?.type === "acp_session_update") {
    return stripAcpSessionIdentifiers(event);
  }
  if (event?.type === "sdk_event" && event.event?.type === "acp_session_update") {
    return { ...event, event: stripAcpSessionIdentifiers(event.event) };
  }
  if (!event || !String(event.type || "").startsWith("acp_interaction_")) return event;
  if (event.type === "acp_interaction_requested") {
    return {
      type: "acp_interaction_requested",
      interaction_id: boundedIdentifier(event.interaction_id),
      protocol_request_id: boundedIdentifier(event.protocol_request_id || event.interaction_id),
      profile_id: boundedIdentifier(event.profile_id),
      interaction_kind: event.interaction_kind === "permission" ? "permission" : "elicitation",
      request: sanitizeAcpInteractionSchema(event.request),
      ts: Number(event.ts) || Date.now(),
      ...(Number.isFinite(Number(event._event_seq)) ? { _event_seq: Number(event._event_seq) } : {}),
    };
  }
  if (event.type === "acp_interaction_acknowledged") {
    return {
      type: "acp_interaction_acknowledged",
      interaction_id: boundedIdentifier(event.interaction_id),
      outcome: TERMINAL_OUTCOMES.has(event.outcome) ? event.outcome : "stale",
      ...(event.delivery_id ? { delivery_id: boundedIdentifier(event.delivery_id) } : {}),
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

export function persistAcpInteractionRequest(db, runId, event) {
  const safeEvent = sanitizeTaskRunAcpInteractionEvent(event);
  const request = safeEvent.request;
  const kind = safeEvent.interaction_kind === "permission"
    ? "permission"
    : request.mode === "url" ? "url" : "form";
  const at = Number(safeEvent.ts) || Date.now();
  insertAcpInteractionRequest(db, {
    id: safeEvent.interaction_id,
    profileId: safeEvent.profile_id,
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

function permissionResponseIsOffered(row, response, disposition) {
  if (row.kind !== "permission") return true;
  const selected = permissionOptionId(response);
  if (!selected) return disposition === "cancel";
  let schema = {};
  try { schema = JSON.parse(row.request_schema_json || "{}"); } catch { /* invalid rows fail closed below */ }
  const offered = new Set((Array.isArray(schema.options) ? schema.options : [])
    .map((option) => option?.optionId)
    .filter((value) => typeof value === "string"));
  return offered.has(selected);
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
} = {}) {
  const deliveries = new Map();
  const activeByInteraction = new Map();
  const privateValues = new Set();

  function collectPrivateValues(value, collected, depth = 0) {
    if (depth > 10) return false;
    if (value == null) return true;
    if (["string", "number", "boolean"].includes(typeof value)) {
      if ((typeof value === "string" && !value)
        || privateValues.has(value)
        || collected.has(value)) return true;
      if (privateValues.size + collected.size >= MAX_PRIVATE_VALUES) return false;
      collected.add(value);
      return true;
    }
    if (Array.isArray(value)) {
      return value.every((entry) => collectPrivateValues(entry, collected, depth + 1));
    }
    if (typeof value !== "object") return true;
    return Object.values(value).every((entry) => collectPrivateValues(entry, collected, depth + 1));
  }

  function rememberPrivateResponse(response) {
    const collected = new Set();
    if (!collectPrivateValues(response?.content, collected)
      || !collectPrivateValues(response?.values, collected)) {
      return false;
    }
    for (const value of collected) privateValues.add(value);
    return true;
  }

  function redactText(value) {
    let result = String(value ?? "");
    for (const privateValue of privateValues) {
      if (typeof privateValue !== "string") continue;
      result = result.split(privateValue).join("[redacted]");
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
      key,
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

    if (outcome === "submitted" && delivery?.action === "respond") {
      const claimed = claimAcpInteractionResponse(db, interactionId, {
        disposition: delivery.disposition,
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
    if (action === "respond" && !permissionResponseIsOffered(existing, response, disposition)) {
      return { ok: false, code: "invalid_response", message: "permission option was not offered" };
    }
    if (action === "respond" && !rememberPrivateResponse(response)) {
      return { ok: false, code: "invalid_response", message: "private response is too deeply nested or complex" };
    }
    const delivery = beginDelivery({ interactionId, action, disposition });
    if (!delivery) {
      return { ok: false, code: "delivery_in_progress", message: "ACP interaction delivery is already in progress" };
    }
    const message = action === "respond"
      ? {
          type: "acp_interaction_response",
          interaction_id: interactionId,
          delivery_id: delivery.deliveryId,
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
  }

  return { respond, cancel, handleWorkerEvent, redactText, redactWorkerEvent, close };
}

export function expireAcpInteractionsForRun(db, runId) {
  return expirePendingAcpInteractionsForRun(db, runId, { disposition: "run_ended" });
}
