import { newAcpInteractionId, newAcpOperationId } from "../core/ids.js";
import { assertAcpProfileBinding } from "../core/acp-profiles.js";
import {
  acpInteractionDisposition,
  normalizeAcpAuthMethodId,
  normalizeAcpProviderSessionId,
  rowToAcpInteraction,
  rowToAcpOperation,
  sanitizeAcpInteractionSchema,
  sanitizeAcpOperationError,
  sanitizeAcpOperationResult,
} from "../core/acp-operations.js";
import {
  cancelAcpOperation,
  completeAcpOperation,
  countActiveAcpOperationsForProfile,
  failAcpOperation,
  getAcpOperationById,
  insertAcpOperation,
  markAcpOperationRunning,
  markAcpOperationWaiting,
} from "../core/db/queries/acp-operations.js";
import {
  cancelAcpInteraction,
  claimAcpInteractionResponse,
  expirePendingAcpInteractionsForOperation,
  finalizeAcpInteractionResponse,
  getAcpInteractionById,
  insertAcpInteractionRequest,
  releaseAcpInteractionResponse,
} from "../core/db/queries/acp-interactions.js";
import { updateAcpProfileProbe } from "../core/db/queries/acp-profiles.js";

const CONTROL_METHODS = Object.freeze({
  probe: "probe",
  authenticate: "authenticate",
  logout: "logout",
  list_sessions: "listSessions",
  delete_session: "deleteSession",
});

const INTERACTION_KIND_ALIASES = Object.freeze({
  permission: "permission",
  form: "form",
  elicitation_form: "form",
  url: "url",
  elicitation_url: "url",
});

function managerError(message, { code = "invalid_state", status = 409 } = {}) {
  return Object.assign(new Error(message), { code, status, safeMessage: message });
}

function boundedIdentifier(value, name, max = 1000) {
  if (typeof value !== "string" || !value.trim()) {
    throw managerError(`${name} is required`, { code: "validation", status: 400 });
  }
  const result = value.trim();
  if (result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw managerError(`${name} is invalid`, { code: "validation", status: 400 });
  }
  return result;
}

function abortReason(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal, "ACP operation cancelled"));
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(abortReason(signal, "ACP operation cancelled"));
    signal.addEventListener("abort", listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", listener));
}

export class AcpOperationManager {
  constructor({ db, broker, controls = {}, logger, now = () => Date.now() } = {}) {
    this.db = db;
    this.broker = broker;
    this.controls = controls;
    this.logger = logger;
    this.now = now;
    this.active = new Map();
  }

  supports(kind) {
    const method = CONTROL_METHODS[kind];
    return Boolean(method && typeof this.controls?.[method] === "function");
  }

  get(operationId) {
    return rowToAcpOperation(getAcpOperationById(this.db, operationId));
  }

  isActive(operationId) {
    return this.active.has(operationId);
  }

  isProfileActive(profileId) {
    return [...this.active.values()].some((entry) => entry.profile.id === profileId);
  }

  start({ profileId, kind, remoteSessionId = null, authMethodId = null } = {}) {
    if (!this.supports(kind)) {
      throw managerError(`ACP ${kind || "operation"} control is not configured`, {
        code: "not_configured",
        status: 501,
      });
    }
    const profile = assertAcpProfileBinding({ db: this.db, id: profileId });
    if (countActiveAcpOperationsForProfile(this.db, profileId) > 0) {
      throw managerError("ACP profile already has an active operation", {
        code: "operation_active",
        status: 409,
      });
    }
    const providerSessionId = kind === "delete_session"
      ? normalizeAcpProviderSessionId(remoteSessionId, profileId)
      : null;
    const methodId = kind === "authenticate" ? normalizeAcpAuthMethodId(authMethodId) : null;
    const now = this.now();
    const id = newAcpOperationId();
    const request = providerSessionId
      ? { providerSessionId }
      : methodId
        ? { authMethodId: methodId }
        : {};
    insertAcpOperation(this.db, {
      id,
      profileId,
      kind,
      remoteSessionId: providerSessionId,
      requestJson: JSON.stringify(request),
      createdAt: now,
      updatedAt: now,
    });
    const record = {
      id,
      profile,
      kind,
      remoteSessionId: providerSessionId,
      providerSessionId,
      authMethodId: methodId,
      controller: new AbortController(),
      pending: new Map(),
      done: null,
    };
    this.active.set(id, record);
    this.#broadcastOperation(id, "queued");
    record.done = Promise.resolve().then(() => this.#run(record));
    return this.get(id);
  }

  async #run(record) {
    const method = CONTROL_METHODS[record.kind];
    const handler = this.controls[method];
    const startedAt = this.now();
    let timeout;
    try {
      if (markAcpOperationRunning(this.db, record.id, { startedAt }).changes !== 1) {
        throw managerError("ACP operation is no longer queued");
      }
      this.#broadcastOperation(record.id, "running");
      timeout = setTimeout(() => {
        record.controller.abort(managerError("ACP operation timed out", {
          code: "operation_timeout",
          status: 408,
        }));
      }, record.profile.probeTimeoutMs);
      timeout.unref?.();

      const result = await raceWithAbort(Promise.resolve().then(() => handler.call(this.controls, {
        profile: record.profile,
        operation: this.get(record.id),
        remoteSessionId: record.remoteSessionId,
        providerSessionId: record.providerSessionId,
        authMethodId: record.authMethodId,
        signal: record.controller.signal,
        onInteraction: (request) => this.#requestInteraction(record, request),
      })), record.controller.signal);
      if (record.controller.signal.aborted) throw abortReason(record.controller.signal, "ACP operation cancelled");

      const sanitized = sanitizeAcpOperationResult(record.kind, result);
      const completedAt = this.now();
      if (completeAcpOperation(this.db, record.id, {
        resultJson: JSON.stringify(sanitized),
        completedAt,
      }).changes !== 1) {
        throw managerError("ACP operation could not be completed");
      }
      if (record.kind === "probe") {
        updateAcpProfileProbe(this.db, record.profile.id, {
          state: "succeeded",
          probedAt: completedAt,
          resultJson: JSON.stringify(sanitized),
          errorJson: "{}",
        });
      }
      this.#broadcastOperation(record.id, "succeeded");
    } catch (error) {
      const cancelled = record.controller.signal.aborted;
      const sanitized = sanitizeAcpOperationError(record.kind, error, { cancelled });
      const completedAt = this.now();
      if (cancelled) {
        cancelAcpOperation(this.db, record.id, {
          errorJson: JSON.stringify(sanitized),
          completedAt,
        });
      } else {
        failAcpOperation(this.db, record.id, {
          errorJson: JSON.stringify(sanitized),
          completedAt,
        });
      }
      if (record.kind === "probe") {
        updateAcpProfileProbe(this.db, record.profile.id, {
          state: "failed",
          probedAt: completedAt,
          resultJson: "{}",
          errorJson: JSON.stringify(sanitized),
        });
      }
      this.logger?.warn?.({
        operation_id: record.id,
        kind: record.kind,
        error_code: sanitized.code,
      }, "ACP operation ended without success");
      this.#broadcastOperation(record.id, cancelled ? "cancelled" : "failed");
    } finally {
      if (timeout) clearTimeout(timeout);
      this.#settlePending(record, "operation_ended");
      this.active.delete(record.id);
    }
    return this.get(record.id);
  }

  #requestInteraction(record, request = {}) {
    if (record.controller.signal.aborted) {
      return Promise.reject(abortReason(record.controller.signal, "ACP operation cancelled"));
    }
    const protocolRequestId = boundedIdentifier(
      request.protocolRequestId || request.requestId || request.id,
      "protocolRequestId",
      500,
    );
    const kind = INTERACTION_KIND_ALIASES[request.kind];
    if (!kind) {
      throw managerError("ACP interaction kind must be permission, form, or url", {
        code: "validation",
        status: 400,
      });
    }
    const requestSchema = sanitizeAcpInteractionSchema(
      request.requestSchema || request.schema || request.payload || request,
    );
    const now = this.now();
    const id = newAcpInteractionId();
    insertAcpInteractionRequest(this.db, {
      id,
      profileId: record.profile.id,
      taskRunId: null,
      operationId: record.id,
      protocolRequestId,
      kind,
      requestSchemaJson: JSON.stringify(requestSchema),
      createdAt: now,
      updatedAt: now,
    });
    if (markAcpOperationWaiting(this.db, record.id, { updatedAt: now }).changes !== 1) {
      cancelAcpInteraction(this.db, id, { disposition: "cancel", resolvedAt: now });
      throw managerError("ACP operation is not accepting interactions");
    }
    const interaction = rowToAcpInteraction(getAcpInteractionById(this.db, id));
    this.broker?.broadcast?.("global", { type: "acp_interaction_requested", interaction });
    this.#broadcastOperation(record.id, "waiting_for_interaction");

    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = record.pending.get(id);
        if (!pending) return;
        record.pending.delete(id);
        reject(abortReason(record.controller.signal, "ACP operation cancelled"));
      };
      record.pending.set(id, { resolve, reject, abort });
      record.controller.signal.addEventListener("abort", abort, { once: true });
      if (record.controller.signal.aborted) abort();
    });
  }

  respond({ operationId, interactionId, response, disposition = null } = {}) {
    const record = this.active.get(operationId);
    if (!record) throw managerError("ACP operation is not active", { code: "not_active", status: 409 });
    const pending = record.pending.get(interactionId);
    if (!pending) throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });
    const row = getAcpInteractionById(this.db, interactionId);
    if (!row || row.operation_id !== operationId) {
      throw managerError("ACP interaction does not belong to this operation", {
        code: "not_found",
        status: 404,
      });
    }
    const safeDisposition = acpInteractionDisposition(rowToAcpInteraction(row), response, disposition);
    const claimed = claimAcpInteractionResponse(this.db, interactionId, {
      disposition: safeDisposition,
      updatedAt: this.now(),
    });
    if (!claimed) throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });

    try {
      pending.resolve(response);
      record.pending.delete(interactionId);
      record.controller.signal.removeEventListener("abort", pending.abort);
      const finalized = finalizeAcpInteractionResponse(this.db, interactionId, { resolvedAt: this.now() });
      if (!finalized) throw managerError("ACP interaction response could not be finalized");
      if (record.pending.size === 0) {
        markAcpOperationRunning(this.db, operationId, { updatedAt: this.now() });
      }
      const interaction = rowToAcpInteraction(finalized);
      this.broker?.broadcast?.("global", { type: "acp_interaction_submitted", interaction });
      this.#broadcastOperation(operationId, "running");
      return interaction;
    } catch (error) {
      releaseAcpInteractionResponse(this.db, interactionId, { updatedAt: this.now() });
      throw error;
    }
  }

  cancelInteraction({ operationId, interactionId } = {}) {
    const record = this.active.get(operationId);
    if (!record) throw managerError("ACP operation is not active", { code: "not_active", status: 409 });
    const pending = record.pending.get(interactionId);
    if (!pending) throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });
    const cancelled = cancelAcpInteraction(this.db, interactionId, {
      disposition: "cancel",
      resolvedAt: this.now(),
    });
    if (!cancelled) throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });
    pending.resolve({ disposition: "cancel" });
    record.pending.delete(interactionId);
    record.controller.signal.removeEventListener("abort", pending.abort);
    if (record.pending.size === 0) {
      markAcpOperationRunning(this.db, operationId, { updatedAt: this.now() });
    }
    const interaction = rowToAcpInteraction(cancelled);
    this.broker?.broadcast?.("global", { type: "acp_interaction_cancelled", interaction });
    this.#broadcastOperation(operationId, "running");
    return interaction;
  }

  abort(operationId, reason = "user requested cancellation") {
    const record = this.active.get(operationId);
    if (!record || record.controller.signal.aborted) return false;
    record.controller.abort(managerError(String(reason || "operation cancelled"), {
      code: "cancelled",
      status: 409,
    }));
    return true;
  }

  async shutdown() {
    const records = [...this.active.values()];
    for (const record of records) this.abort(record.id, "Worklab is shutting down");
    await Promise.allSettled(records.map((record) => record.done));
  }

  #settlePending(record, disposition) {
    expirePendingAcpInteractionsForOperation(this.db, record.id, {
      disposition,
      resolvedAt: this.now(),
    });
    const error = managerError("ACP operation ended before interaction response", {
      code: "operation_ended",
      status: 409,
    });
    for (const [id, pending] of record.pending) {
      record.controller.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      record.pending.delete(id);
    }
  }

  #broadcastOperation(operationId, state) {
    const operation = this.get(operationId);
    this.broker?.broadcast?.("global", { type: "acp_operation_updated", state, operation });
  }
}

export function createAcpOperationManager(options) {
  return new AcpOperationManager(options);
}
