import { newAcpInteractionId, newAcpOperationId } from "../core/ids.js";
import { assertAcpProfileBinding } from "../core/acp-profiles.js";
import {
  acpInteractionDisposition,
  normalizeAcpAuthMethodId,
  normalizeAcpProviderSessionId,
  normalizeAcpSessionCursor,
  rowToAcpInteraction,
  rowToAcpOperation,
  sanitizeAcpInteractionRequest,
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
  listActiveAcpOperations,
  markAcpOperationRunning,
  markAcpOperationWaiting,
} from "../core/db/queries/acp-operations.js";
import {
  cancelAcpInteraction,
  claimAcpInteractionResponse,
  expirePendingAcpInteractionsForOperation,
  expireUnresolvedAcpInteractionsForTerminalOperations,
  finalizeAcpInteractionResponse,
  getAcpInteractionById,
  insertAcpInteractionRequest,
} from "../core/db/queries/acp-interactions.js";
import { updateAcpProfileProbe } from "../core/db/queries/acp-profiles.js";
import {
  ACP_PRIVATE_URL_HANDOFF,
  createAcpUrlPublicRequest,
  inspectAcpUrlHandoff,
} from "../core/acp-url-handoff.js";

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

const DEFAULT_ABORT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_PRIVATE_RESPONSE_VALUES = 10_000;
const MAX_PRIVATE_RESPONSE_DEPTH = 10;
const MAX_PRIVATE_RESPONSE_NODES = 20_000;
const MAX_PRIVATE_RESPONSE_STRING_CHARS = 4 * 1024 * 1024;

function managerError(message, { code = "invalid_state", status = 409 } = {}) {
  return Object.assign(new Error(message), { code, status, safeMessage: message });
}

function operationActiveError() {
  return managerError("ACP profile already has an active operation", {
    code: "operation_active",
    status: 409,
  });
}

function isActiveProfileConstraint(error) {
  return error?.code === "SQLITE_CONSTRAINT_UNIQUE"
    && String(error.message || "").includes("acp_operations.profile_id");
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

async function waitForSettlement(promise, timeoutMs) {
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const settled = Promise.resolve(promise).then(() => true, () => true);
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createPrivateResponseTracker() {
  const values = new Set();
  let stringChars = 0;
  let failedClosed = false;

  function collect(value, collected, state, ancestors, depth = 0) {
    if (depth > MAX_PRIVATE_RESPONSE_DEPTH) return false;
    state.nodes += 1;
    if (state.nodes > MAX_PRIVATE_RESPONSE_NODES) return false;
    if (value == null) return true;
    if (typeof value === "string") {
      if (!value || values.has(value) || collected.has(value)) return true;
      if (values.size + collected.size >= MAX_PRIVATE_RESPONSE_VALUES
        || stringChars + state.stringChars + value.length > MAX_PRIVATE_RESPONSE_STRING_CHARS) {
        return false;
      }
      collected.add(value);
      state.stringChars += value.length;
      return true;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      if (values.has(value) || collected.has(value)) return true;
      if (values.size + collected.size >= MAX_PRIVATE_RESPONSE_VALUES) return false;
      collected.add(value);
      return true;
    }
    if (typeof value === "boolean") {
      if (values.has(value) || collected.has(value)) return true;
      if (values.size + collected.size >= MAX_PRIVATE_RESPONSE_VALUES) return false;
      collected.add(value);
      return true;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) return false;
      ancestors.add(value);
      const valid = value.every((entry) => collect(entry, collected, state, ancestors, depth + 1));
      ancestors.delete(value);
      return valid;
    }
    if (!isPlainObject(value) || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = Object.values(value)
      .every((entry) => collect(entry, collected, state, ancestors, depth + 1));
    ancestors.delete(value);
    return valid;
  }

  function rememberValues(value) {
    if (failedClosed) return false;
    const collected = new Set();
    const state = { nodes: 0, stringChars: 0 };
    const ancestors = new WeakSet();
    const valid = collect(value, collected, state, ancestors);
    if (!valid) {
      failedClosed = true;
      return false;
    }
    for (const value of collected) values.add(value);
    stringChars += state.stringChars;
    return true;
  }

  function rememberResponse(response) {
    return rememberValues([response?.content, response?.values]);
  }

  function clear() {
    values.clear();
    stringChars = 0;
    failedClosed = true;
  }

  return {
    values,
    rememberValues,
    rememberResponse,
    clear,
    get failedClosed() { return failedClosed; },
  };
}

function permissionOptionId(response) {
  const outcome = response?.outcome && typeof response.outcome === "object"
    ? response.outcome
    : null;
  return outcome?.optionId || outcome?.option_id || response?.optionId || response?.option_id || null;
}

function assertOfferedPermissionResponse(row, response, disposition) {
  if (row.kind !== "permission") return;
  let request = {};
  try { request = JSON.parse(row.request_schema_json || "{}"); } catch { /* fail closed below */ }
  const offered = new Map((Array.isArray(request.options) ? request.options : [])
    .map((option) => [option?.optionId || option?.id, option])
    .filter(([optionId]) => typeof optionId === "string" && optionId.length > 0));
  const selected = permissionOptionId(response);
  if (disposition === "cancel") {
    if (selected == null) return;
    throw managerError("cancelled permission responses cannot select an option", {
      code: "validation",
      status: 400,
    });
  }
  const option = typeof selected === "string" ? offered.get(selected) : null;
  if (!option) {
    throw managerError("permission response must select an offered option", {
      code: "validation",
      status: 400,
    });
  }
  const optionKind = typeof option.kind === "string" ? option.kind.trim().toLowerCase() : "";
  if (disposition !== "selected" && disposition !== optionKind) {
    throw managerError("permission disposition does not match the selected option", {
      code: "validation",
      status: 400,
    });
  }
}

function canonicalInteractionResponse(row, response, disposition) {
  const source = isPlainObject(response) ? response : {};
  if (row.kind === "permission") {
    if (disposition === "cancel") return { outcome: { outcome: "cancelled" } };
    return {
      outcome: {
        outcome: "selected",
        optionId: permissionOptionId(source),
      },
    };
  }
  if (disposition === "accept") {
    const content = Object.hasOwn(source, "content") ? source.content : source.values;
    return content === undefined
      ? { action: "accept" }
      : { action: "accept", content };
  }
  return { action: disposition };
}

export class AcpOperationManager {
  constructor({
    db,
    broker,
    controls = {},
    logger,
    now = () => Date.now(),
    abortCleanupTimeoutMs = DEFAULT_ABORT_CLEANUP_TIMEOUT_MS,
    urlHandoffStore = null,
  } = {}) {
    this.db = db;
    this.broker = broker;
    this.controls = controls;
    this.logger = logger;
    this.now = now;
    this.abortCleanupTimeoutMs = Number.isFinite(abortCleanupTimeoutMs) && abortCleanupTimeoutMs > 0
      ? abortCleanupTimeoutMs
      : DEFAULT_ABORT_CLEANUP_TIMEOUT_MS;
    this.urlHandoffStore = urlHandoffStore;
    this.active = new Map();
    this.quarantinedProfiles = new Map();
    this.closing = false;
    this.#reconcileOrphanedOperations();
  }

  #reconcileOrphanedOperations() {
    const completedAt = this.now();
    const reconcile = this.db.transaction(() => {
      let operations = 0;
      const orphaned = listActiveAcpOperations(this.db)
        .filter((operation) => !this.active.has(operation.id));
      for (const operation of orphaned) {
        const errorJson = JSON.stringify(sanitizeAcpOperationError(
          operation.kind,
          managerError("Worklab restarted before the ACP operation completed.", {
            code: "coordinator_restarted",
            status: 500,
          }),
        ));
        const terminalized = failAcpOperation(this.db, operation.id, {
          errorJson,
          completedAt,
        });
        if (terminalized.changes !== 1) continue;
        operations += 1;
      }
      const expiredInteractions = expireUnresolvedAcpInteractionsForTerminalOperations(this.db, {
        disposition: "operation_ended",
        resolvedAt: completedAt,
      }).changes;
      return { operations, expiredInteractions };
    });
    const result = reconcile();
    if (result.operations > 0 || result.expiredInteractions > 0) {
      this.logger?.warn?.({
        operations: result.operations,
        expired_interactions: result.expiredInteractions,
      }, "reconciled orphaned ACP operations at boot");
    }
    return result;
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
    return [...this.active.values()].some((entry) => entry.profile.id === profileId)
      || this.quarantinedProfiles.has(profileId)
      || countActiveAcpOperationsForProfile(this.db, profileId) > 0;
  }

  #isProfileLocallyOccupied(profileId) {
    return [...this.active.values()].some((entry) => entry.profile.id === profileId)
      || this.quarantinedProfiles.has(profileId);
  }

  start({ profileId, kind, remoteSessionId = null, authMethodId = null, cursor = null } = {}) {
    if (this.closing) {
      throw managerError("ACP operation manager is shutting down", {
        code: "shutting_down",
        status: 503,
      });
    }
    if (!this.supports(kind)) {
      throw managerError(`ACP ${kind || "operation"} control is not configured`, {
        code: "not_configured",
        status: 501,
      });
    }
    const profile = assertAcpProfileBinding({ db: this.db, id: profileId });
    if (this.#isProfileLocallyOccupied(profileId)) throw operationActiveError();
    const providerSessionId = kind === "delete_session"
      ? normalizeAcpProviderSessionId(remoteSessionId, profileId)
      : null;
    const methodId = kind === "authenticate" ? normalizeAcpAuthMethodId(authMethodId) : null;
    const sessionCursor = kind === "list_sessions"
      ? normalizeAcpSessionCursor(cursor, profileId)
      : null;
    const now = this.now();
    const id = newAcpOperationId();
    const request = providerSessionId
      ? { providerSessionId }
      : methodId
        ? { authMethodId: methodId }
        : sessionCursor
          ? { cursor: sessionCursor }
          : {};
    try {
      insertAcpOperation(this.db, {
        id,
        profileId,
        kind,
        remoteSessionId: providerSessionId,
        requestJson: JSON.stringify(request),
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isActiveProfileConstraint(error)) throw operationActiveError();
      throw error;
    }
    const record = {
      id,
      profile,
      kind,
      remoteSessionId: providerSessionId,
      providerSessionId,
      authMethodId: methodId,
      cursor: sessionCursor,
      controller: new AbortController(),
      pending: new Map(),
      privateResponses: createPrivateResponseTracker(),
      deadline: null,
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
    let handlerPromise;
    try {
      if (markAcpOperationRunning(this.db, record.id, { startedAt }).changes !== 1) {
        throw managerError("ACP operation is no longer queued");
      }
      this.#broadcastOperation(record.id, "running");
      this.#armDeadline(record);
      handlerPromise = Promise.resolve().then(() => {
        if (record.controller.signal.aborted) {
          throw abortReason(record.controller.signal, "ACP operation cancelled");
        }
        return handler.call(this.controls, {
          profile: record.profile,
          operation: this.get(record.id),
          remoteSessionId: record.remoteSessionId,
          providerSessionId: record.providerSessionId,
          authMethodId: record.authMethodId,
          cursor: record.cursor,
          signal: record.controller.signal,
          onInteraction: (request) => this.#requestInteraction(record, request),
        });
      });
      const result = await raceWithAbort(handlerPromise, record.controller.signal);
      if (record.controller.signal.aborted) throw abortReason(record.controller.signal, "ACP operation cancelled");

      const sanitized = sanitizeAcpOperationResult(record.kind, result, {
        profileId: record.profile.id,
        privateValues: record.privateResponses.values,
        privacyFailedClosed: record.privateResponses.failedClosed,
      });
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
      const failure = this.#operationFailure(record, error);
      this.#clearDeadline(record);
      this.#settlePending(record, "operation_ended");
      if (record.controller.signal.aborted && handlerPromise) {
        const settled = await waitForSettlement(handlerPromise, this.abortCleanupTimeoutMs);
        if (!settled) {
          this.#quarantineProfile(record, handlerPromise, failure);
          this.logger?.warn?.({
            operation_id: record.id,
            kind: record.kind,
            cleanup_timeout_ms: this.abortCleanupTimeoutMs,
          }, "ACP operation handler did not settle after cancellation");
          return this.get(record.id);
        }
      }
      this.#persistOperationFailure(record, failure);
    } finally {
      this.#clearDeadline(record);
      this.#settlePending(record, "operation_ended");
      record.privateResponses.clear();
      this.active.delete(record.id);
    }
    return this.get(record.id);
  }

  #operationFailure(record, error) {
    const cancelled = record.controller.signal.aborted
      && record.controller.signal.reason?.code !== "operation_timeout";
    return {
      cancelled,
      sanitized: sanitizeAcpOperationError(record.kind, error, {
        cancelled,
        privateValues: record.privateResponses.values,
        privacyFailedClosed: record.privateResponses.failedClosed,
      }),
    };
  }

  #persistOperationFailure(record, { cancelled, sanitized }) {
    const completedAt = this.now();
    const transition = cancelled ? cancelAcpOperation : failAcpOperation;
    transition(this.db, record.id, {
      errorJson: JSON.stringify(sanitized),
      completedAt,
    });
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
  }

  #quarantineProfile(record, handlerPromise, failure) {
    const entry = { operationId: record.id };
    this.quarantinedProfiles.set(record.profile.id, entry);
    const settle = () => {
      try {
        this.#persistOperationFailure(record, failure);
      } catch (error) {
        this.logger?.warn?.({
          operation_id: record.id,
          kind: record.kind,
          error_code: error?.code || "quarantine_settlement_failed",
        }, "ACP operation quarantine could not be settled");
      } finally {
        if (this.quarantinedProfiles.get(record.profile.id) === entry) {
          this.quarantinedProfiles.delete(record.profile.id);
        }
      }
    };
    Promise.resolve(handlerPromise).then(settle, settle);
  }

  #clearDeadline(record) {
    if (!record.deadline) return;
    clearTimeout(record.deadline);
    record.deadline = null;
  }

  #armDeadline(record) {
    this.#clearDeadline(record);
    if (record.controller.signal.aborted || record.pending.size > 0) return;
    record.deadline = setTimeout(() => {
      record.deadline = null;
      record.controller.abort(managerError("ACP operation timed out", {
        code: "operation_timeout",
        status: 408,
      }));
    }, record.profile.probeTimeoutMs);
    record.deadline.unref?.();
  }

  #clearInteractionDeadline(pending) {
    if (!pending?.deadline) return;
    clearTimeout(pending.deadline);
    pending.deadline = null;
  }

  #requestInteraction(record, request = {}) {
    if (record.controller.signal.aborted) {
      return Promise.reject(abortReason(record.controller.signal, "ACP operation cancelled"));
    }
    const candidateProtocolRequestId = boundedIdentifier(
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
    const rawPrivateUrl = kind === "url" ? request[ACP_PRIVATE_URL_HANDOFF] : null;
    const privateUrl = kind === "url" ? inspectAcpUrlHandoff(rawPrivateUrl) : null;
    if (kind === "url" && (!privateUrl
      || !record.privateResponses.rememberValues(privateUrl.privateValues))) {
      throw managerError("ACP URL interaction cannot be handed off safely", {
        code: "url_handoff_unavailable",
        status: 503,
      });
    }
    const requestSchemaSource = kind === "url"
      ? createAcpUrlPublicRequest(rawPrivateUrl)
      : request.requestSchema || request.schema || request.payload || request;
    const safeRequest = sanitizeAcpInteractionRequest({
      source: request,
      protocolRequestId: candidateProtocolRequestId,
      requestSchema: requestSchemaSource,
      privateValues: record.privateResponses.values,
      privacyFailedClosed: record.privateResponses.failedClosed,
    });
    const { protocolRequestId, requestSchema } = safeRequest;
    const now = this.now();
    const id = newAcpInteractionId();
    const entersWaiting = record.pending.size === 0;
    let retainedUrl = false;
    if (kind === "url") {
      retainedUrl = this.urlHandoffStore?.retain?.({
        interactionId: id,
        ownerKind: "operation",
        ownerId: record.id,
        profileId: record.profile.id,
        url: rawPrivateUrl,
      }) === true;
      if (!retainedUrl) {
        throw managerError("ACP URL interaction cannot be handed off safely", {
          code: "url_handoff_unavailable",
          status: 503,
        });
      }
    }
    try {
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
      if (entersWaiting
        && markAcpOperationWaiting(this.db, record.id, { updatedAt: now }).changes !== 1) {
        cancelAcpInteraction(this.db, id, { disposition: "cancel", resolvedAt: now });
        throw managerError("ACP operation is not accepting interactions");
      }
    } catch (error) {
      if (retainedUrl) this.urlHandoffStore?.remove?.(id);
      throw error;
    }
    if (entersWaiting) this.#clearDeadline(record);
    const interaction = rowToAcpInteraction(getAcpInteractionById(this.db, id));
    this.broker?.broadcast?.("global", { type: "acp_interaction_requested", interaction });
    if (entersWaiting) this.#broadcastOperation(record.id, "waiting_for_interaction");

    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = record.pending.get(id);
        if (!pending) return;
        this.#clearInteractionDeadline(pending);
        record.pending.delete(id);
        reject(abortReason(record.controller.signal, "ACP operation cancelled"));
      };
      const pending = { resolve, reject, abort, deadline: null };
      record.pending.set(id, pending);
      if (kind === "url") {
        pending.deadline = setTimeout(() => {
          pending.deadline = null;
          if (!record.pending.has(id)) return;
          try {
            this.cancelInteraction({ operationId: record.id, interactionId: id });
          } catch {
            // Operation settlement owns cleanup when the interaction is no longer pending.
          }
        }, this.urlHandoffStore.ttlMs);
        pending.deadline.unref?.();
      }
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
    assertOfferedPermissionResponse(row, response, safeDisposition);
    const safeResponse = canonicalInteractionResponse(row, response, safeDisposition);
    if (!record.privateResponses.rememberResponse(safeResponse)) {
      throw managerError("ACP interaction response is too deeply nested or complex", {
        code: "validation",
        status: 400,
      });
    }
    const resumesOperation = record.pending.size === 1;
    const finalized = this.db.transaction(() => {
      const claimed = claimAcpInteractionResponse(this.db, interactionId, {
        disposition: safeDisposition,
        updatedAt: this.now(),
      });
      if (!claimed) throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });
      const finalized = finalizeAcpInteractionResponse(this.db, interactionId, { resolvedAt: this.now() });
      if (!finalized) throw managerError("ACP interaction response could not be finalized");
      if (resumesOperation) {
        if (markAcpOperationRunning(this.db, operationId, { updatedAt: this.now() }).changes !== 1) {
          throw managerError("ACP operation could not resume after interaction");
        }
      }
      return finalized;
    })();
    this.urlHandoffStore?.remove?.(interactionId, {
      ownerKind: "operation",
      ownerId: operationId,
      profileId: record.profile.id,
    });
    this.#clearInteractionDeadline(pending);
    record.pending.delete(interactionId);
    record.controller.signal.removeEventListener("abort", pending.abort);
    if (resumesOperation) this.#armDeadline(record);
    pending.resolve(safeResponse);
    const interaction = rowToAcpInteraction(finalized);
    this.broker?.broadcast?.("global", { type: "acp_interaction_submitted", interaction });
    if (resumesOperation) this.#broadcastOperation(operationId, "running");
    return interaction;
  }

  cancelInteraction({ operationId, interactionId } = {}) {
    const record = this.active.get(operationId);
    if (!record) throw managerError("ACP operation is not active", { code: "not_active", status: 409 });
    const pending = record.pending.get(interactionId);
    if (!pending) throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });
    const resumesOperation = record.pending.size === 1;
    const cancelled = this.db.transaction(() => {
      const cancelled = cancelAcpInteraction(this.db, interactionId, {
        disposition: "cancel",
        resolvedAt: this.now(),
      });
      if (!cancelled) {
        throw managerError("ACP interaction is not pending", { code: "not_pending", status: 409 });
      }
      if (resumesOperation
        && markAcpOperationRunning(this.db, operationId, { updatedAt: this.now() }).changes !== 1) {
        throw managerError("ACP operation could not resume after interaction");
      }
      return cancelled;
    })();
    this.urlHandoffStore?.remove?.(interactionId, {
      ownerKind: "operation",
      ownerId: operationId,
      profileId: record.profile.id,
    });
    this.#clearInteractionDeadline(pending);
    record.pending.delete(interactionId);
    record.controller.signal.removeEventListener("abort", pending.abort);
    if (resumesOperation) this.#armDeadline(record);
    pending.resolve({ disposition: "cancel" });
    const interaction = rowToAcpInteraction(cancelled);
    this.broker?.broadcast?.("global", { type: "acp_interaction_cancelled", interaction });
    if (resumesOperation) this.#broadcastOperation(operationId, "running");
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
    this.closing = true;
    const records = [...this.active.values()];
    for (const record of records) this.abort(record.id, "Worklab is shutting down");
    await Promise.allSettled(records.map((record) => record.done));
    for (const record of records) this.urlHandoffStore?.removeOwner?.("operation", record.id);
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
      this.urlHandoffStore?.remove?.(id, {
        ownerKind: "operation",
        ownerId: record.id,
        profileId: record.profile.id,
      });
      this.#clearInteractionDeadline(pending);
      record.controller.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      record.pending.delete(id);
    }
    this.urlHandoffStore?.removeOwner?.("operation", record.id);
  }

  #broadcastOperation(operationId, state) {
    const operation = this.get(operationId);
    this.broker?.broadcast?.("global", { type: "acp_operation_updated", state, operation });
  }
}

export function createAcpOperationManager(options) {
  return new AcpOperationManager(options);
}
