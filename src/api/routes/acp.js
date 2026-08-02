import {
  acpInteractionDisposition,
  createAcpProfile,
  deleteAcpProfileRecord,
  getAcpProfile,
  getAcpProfiles,
  normalizeMonoDiscovery,
  normalizeAcpAuthMethodId,
  normalizeAcpProviderSessionId,
  rowToAcpInteraction,
  rowToAcpOperation,
  updateAcpProfileRecord,
} from "../../core/index.js";
import {
  getAcpInteractionById,
  listAcpInteractions,
  listAcpInteractionsForOperation,
} from "../../core/db/queries/acp-interactions.js";
import {
  getAcpOperationById,
  listAcpOperationsForProfile,
} from "../../core/db/queries/acp-operations.js";
import { listMonoAcpSourceBindings } from "../../core/db/queries/acp-profiles.js";

const INTERACTION_STATES = new Set(["pending", "submitted", "cancelled", "expired"]);
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

function routeError(message, { code = "validation", status = 400 } = {}) {
  return Object.assign(new Error(message), { code, status, safeMessage: message });
}

function sendError(res, error, {
  status = 400,
  code = "validation",
  message = null,
} = {}) {
  const safeMessage = message || error?.publicMessage || error?.safeMessage || null;
  const trusted = Boolean(safeMessage);
  const publicStatus = trusted && Number.isInteger(error?.status) ? error.status : status;
  const candidateCode = trusted && typeof error?.code === "string" ? error.code : code;
  const publicCode = /^[A-Za-z0-9_.-]{1,100}$/u.test(candidateCode) ? candidateCode : code;
  const publicMessage = safeMessage || "Request failed";
  return res.status(publicStatus).json({
    error: { code: publicCode, message: publicMessage },
  });
}

function requiredControl(controls, name, message) {
  const control = controls?.[name];
  if (typeof control !== "function") {
    throw routeError(message, { code: "not_configured", status: 501 });
  }
  return control;
}

function discoveryWithBindings(db, discovery) {
  const bindings = new Map(listMonoAcpSourceBindings(db).map((row) => [row.mono_source_id, row]));
  return {
    ...discovery,
    sources: discovery.sources.map((source) => {
      const row = bindings.get(source.sourceId);
      if (!row) return { ...source, imported: false };
      return {
        ...source,
        imported: true,
        binding: {
          profileId: row.profile_id,
          agentName: row.agent_name,
          displayName: row.agent_display_name,
          enabled: !!row.agent_enabled,
        },
      };
    }),
  };
}

function normalizedLimit(value, fallback = 200) {
  if (value == null || value === "") return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw routeError("limit must be an integer between 1 and 500");
  }
  return limit;
}

function resolvedMonoPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError("mono source resolution returned an invalid payload", {
      code: "invalid_source",
      status: 502,
    });
  }
  return {
    descriptor: value.descriptor,
    command: value.command,
    args: value.args,
    envKeys: value.envKeys,
  };
}

async function runAbortableRequest(req, timeoutMs, callback) {
  const controller = new AbortController();
  const abort = () => controller.abort(routeError("request cancelled", {
    code: "cancelled",
    status: 499,
  }));
  req.once("aborted", abort);
  const timeout = setTimeout(() => controller.abort(routeError("request timed out", {
    code: "timeout",
    status: 504,
  })), timeoutMs);
  timeout.unref?.();
  try {
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => callback(controller.signal)), aborted]);
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abort);
  }
}

async function invokeExternalControl({
  req,
  controls,
  name,
  unavailableMessage,
  failureCode,
  failureMessage,
  args = {},
}) {
  const control = requiredControl(controls, name, unavailableMessage);
  try {
    return await runAbortableRequest(req, DEFAULT_DISCOVERY_TIMEOUT_MS, (signal) => (
      control.call(controls, { ...args, signal, timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS })
    ));
  } catch (error) {
    if (new Set(["not_configured", "cancelled", "timeout"]).has(error?.code)) throw error;
    throw routeError(failureMessage, { code: failureCode, status: 502 });
  }
}

async function invokeWatcherInteraction(callback, failureMessage) {
  try {
    const result = await callback();
    if (result?.ok !== false) return result;
    const conflictCodes = new Set([
      "no_pending_interaction",
      "delivery_in_progress",
      "run_not_active",
    ]);
    const validationCodes = new Set(["invalid_response", "invalid_decision"]);
    const status = conflictCodes.has(result.code) ? 409 : validationCodes.has(result.code) ? 400 : 503;
    throw routeError(
      status === 409
        ? "ACP interaction is no longer available"
        : status === 400
          ? "ACP interaction response is invalid"
          : failureMessage,
      {
        code: result.code || "interaction_delivery_failed",
        status,
      },
    );
  } catch (error) {
    if (error?.safeMessage) throw error;
    throw routeError(failureMessage, {
      code: "interaction_delivery_failed",
      status: 502,
    });
  }
}

function operationOr404(db, operationId) {
  const operation = rowToAcpOperation(getAcpOperationById(db, operationId));
  if (!operation) throw routeError("ACP operation not found", { code: "not_found", status: 404 });
  return operation;
}

function interactionOr404(db, interactionId) {
  const row = getAcpInteractionById(db, interactionId);
  if (!row) throw routeError("ACP interaction not found", { code: "not_found", status: 404 });
  return row;
}

function interactionUrlOwner(row) {
  if (row?.operation_id) {
    return {
      ownerKind: "operation",
      ownerId: row.operation_id,
      profileId: row.profile_id,
    };
  }
  if (row?.task_run_id) {
    return {
      ownerKind: "run",
      ownerId: row.task_run_id,
      profileId: row.profile_id,
    };
  }
  return null;
}

function sendUrlHandoffGone(res) {
  return res.status(410).json({
    error: {
      code: "url_handoff_gone",
      message: "ACP URL handoff is no longer available",
    },
  });
}

function startOperation(res, manager, profileId, kind, options = {}) {
  if (!manager) {
    return sendError(res, routeError("ACP operation manager is not configured", {
      code: "not_configured",
      status: 501,
    }));
  }
  try {
    const operation = manager.start({ profileId, kind, ...options });
    return res.status(202).json({ operation });
  } catch (error) {
    return sendError(res, error);
  }
}

export function registerAcpRoutes(app, {
  db,
  broker,
  watcher,
  acpControls = {},
  acpOperationManager,
  acpUrlHandoffStore,
}) {
  app.get("/api/acp/discovery/mono", async (req, res) => {
    try {
      const discovery = await invokeExternalControl({
        req,
        controls: acpControls,
        name: "discoverMono",
        unavailableMessage: "mono-agent ACP discovery is not configured",
        failureCode: "discovery_failed",
        failureMessage: "mono-agent ACP discovery failed",
      });
      res.json({ discovery: discoveryWithBindings(db, normalizeMonoDiscovery(discovery)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/acp/profiles", (_req, res) => {
    res.json({ profiles: getAcpProfiles({ db }) });
  });

  app.get("/api/acp/profiles/:id", (req, res) => {
    const profile = getAcpProfile({ db, id: req.params.id });
    if (!profile) return sendError(res, routeError("ACP profile not found", {
      code: "not_found",
      status: 404,
    }));
    return res.json({ profile });
  });

  app.post("/api/acp/profiles", async (req, res) => {
    const body = req.body || {};
    const monoRequested = Object.hasOwn(body, "sourceId")
      || Object.hasOwn(body, "source_id")
      || body.driver === "mono";
    try {
      let mono = null;
      if (monoRequested) {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "sourceId")) {
          throw routeError("mono profile imports accept exactly one field: sourceId");
        }
        const sourceId = body.sourceId;
        if (typeof sourceId !== "string" || !sourceId.trim()) {
          throw routeError("sourceId is required for mono profiles");
        }
        const resolved = await invokeExternalControl({
          req,
          controls: acpControls,
          name: "resolveMonoSource",
          unavailableMessage: "mono-agent ACP source resolution is not configured",
          failureCode: "source_resolution_failed",
          failureMessage: "mono-agent ACP source resolution failed",
          args: { sourceId: sourceId.trim() },
        });
        mono = resolvedMonoPayload(resolved);
      }
      const profile = createAcpProfile({ db, input: body, mono });
      broker?.broadcast?.("global", { type: "acp_profile_created", id: profile.id });
      res.status(201).json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch("/api/acp/profiles/:id", (req, res) => {
    try {
      const profile = updateAcpProfileRecord({ db, id: req.params.id, input: req.body || {} });
      broker?.broadcast?.("global", { type: "acp_profile_updated", id: profile.id });
      res.json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete("/api/acp/profiles/:id", (req, res) => {
    try {
      if (acpOperationManager?.isProfileActive?.(req.params.id)) {
        throw routeError("ACP profile has an active operation", {
          code: "profile_in_use",
          status: 409,
        });
      }
      const deleted = deleteAcpProfileRecord({ db, id: req.params.id });
      broker?.broadcast?.("global", { type: "acp_profile_deleted", id: deleted.id });
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/acp/profiles/:id/probe", (req, res) => (
    startOperation(res, acpOperationManager, req.params.id, "probe")
  ));
  app.post("/api/acp/profiles/:id/authenticate", (req, res) => {
    try {
      const body = req.body || {};
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "authMethodId")) {
        throw routeError("authenticate accepts exactly one field: authMethodId");
      }
      const authMethodId = normalizeAcpAuthMethodId(body.authMethodId);
      return startOperation(res, acpOperationManager, req.params.id, "authenticate", {
        authMethodId,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
  app.post("/api/acp/profiles/:id/logout", (req, res) => (
    startOperation(res, acpOperationManager, req.params.id, "logout")
  ));
  app.post("/api/acp/profiles/:id/sessions:list", (req, res) => {
    try {
      const body = req.body == null ? {} : req.body;
      if (typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((key) => key !== "cursor")) {
        throw routeError("sessions:list accepts only one optional field: cursor");
      }
      return startOperation(res, acpOperationManager, req.params.id, "list_sessions", {
        cursor: Object.hasOwn(body, "cursor") ? body.cursor : null,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
  app.delete("/api/acp/profiles/:id/sessions/:sessionId", (req, res) => {
    try {
      const providerSessionId = normalizeAcpProviderSessionId(req.params.sessionId, req.params.id);
      return startOperation(res, acpOperationManager, req.params.id, "delete_session", {
        remoteSessionId: providerSessionId,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get("/api/acp/profiles/:id/operations", (req, res) => {
    try {
      if (!getAcpProfile({ db, id: req.params.id })) {
        throw routeError("ACP profile not found", { code: "not_found", status: 404 });
      }
      const limit = normalizedLimit(req.query.limit, 50);
      const operations = listAcpOperationsForProfile(db, req.params.id, limit).map(rowToAcpOperation);
      res.json({ operations });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/acp/operations/:id", (req, res) => {
    try {
      res.json({ operation: operationOr404(db, req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/acp/operations/:id/cancel", (req, res) => {
    try {
      const operation = operationOr404(db, req.params.id);
      if (Object.keys(req.body || {}).length > 0) {
        throw routeError("operation cancellation does not accept a request body");
      }
      if (typeof acpOperationManager?.abort !== "function") {
        throw routeError("ACP operation manager is not configured", {
          code: "not_configured",
          status: 501,
        });
      }
      if (!acpOperationManager.abort(operation.id)) {
        throw routeError("ACP operation is not active", {
          code: "not_active",
          status: 409,
        });
      }
      res.status(202).json({
        operation: rowToAcpOperation(getAcpOperationById(db, operation.id)) || operation,
        cancellationRequested: true,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/acp/operations/:id/interactions", (req, res) => {
    try {
      operationOr404(db, req.params.id);
      const interactions = listAcpInteractionsForOperation(db, req.params.id).map(rowToAcpInteraction);
      res.json({ interactions });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/acp/interactions", (req, res) => {
    try {
      const state = req.query.state || "pending";
      if (!INTERACTION_STATES.has(state)) {
        throw routeError("state must be pending, submitted, cancelled, or expired");
      }
      const limit = normalizedLimit(req.query.limit);
      const interactions = listAcpInteractions(db, {
        state,
        profileId: req.query.profileId || null,
        limit,
      }).map(rowToAcpInteraction);
      res.json({ interactions });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/acp/interactions/:id/url:open", (req, res) => {
    const row = getAcpInteractionById(db, req.params.id);
    const owner = interactionUrlOwner(row);
    if (!row || row.state !== "pending" || row.kind !== "url" || !owner) {
      return sendUrlHandoffGone(res);
    }
    const url = acpUrlHandoffStore?.consume?.({
      interactionId: row.id,
      ...owner,
    });
    if (!url) return sendUrlHandoffGone(res);

    res.status(303);
    res.set({
      Location: url,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    return res.end();
  });

  app.post("/api/acp/interactions/:id/respond", async (req, res) => {
    try {
      const row = interactionOr404(db, req.params.id);
      const owner = interactionUrlOwner(row);
      const body = req.body || {};
      const response = Object.hasOwn(body, "response") ? body.response : body;
      const disposition = acpInteractionDisposition(
        rowToAcpInteraction(row),
        response,
        body.disposition || null,
      );
      let interaction;
      if (row.operation_id) {
        interaction = acpOperationManager?.respond?.({
          operationId: row.operation_id,
          interactionId: row.id,
          response,
          disposition,
        });
        if (!interaction) throw routeError("ACP operation manager is not configured", {
          code: "not_configured",
          status: 501,
        });
      } else {
        if (typeof watcher?.sendRunAcpInteractionResponse !== "function") {
          throw routeError("task-run ACP interaction responses are not configured", {
            code: "not_configured",
            status: 501,
          });
        }
        await invokeWatcherInteraction(() => watcher.sendRunAcpInteractionResponse({
          runId: row.task_run_id,
          interactionId: row.id,
          response,
          disposition,
        }), "task-run ACP interaction response failed");
        interaction = rowToAcpInteraction(interactionOr404(db, row.id));
        if (interaction.state === "pending") {
          throw routeError("task-run ACP interaction response was not accepted", {
            code: "interaction_delivery_failed",
            status: 502,
          });
        }
      }
      if (owner) acpUrlHandoffStore?.remove?.(row.id, owner);
      res.json({ interaction });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/acp/interactions/:id/cancel", async (req, res) => {
    try {
      const row = interactionOr404(db, req.params.id);
      const owner = interactionUrlOwner(row);
      let interaction;
      if (row.operation_id) {
        interaction = acpOperationManager?.cancelInteraction?.({
          operationId: row.operation_id,
          interactionId: row.id,
        });
        if (!interaction) throw routeError("ACP operation manager is not configured", {
          code: "not_configured",
          status: 501,
        });
      } else {
        if (typeof watcher?.sendRunAcpInteractionCancel !== "function") {
          throw routeError("task-run ACP interaction cancellation is not configured", {
            code: "not_configured",
            status: 501,
          });
        }
        await invokeWatcherInteraction(() => watcher.sendRunAcpInteractionCancel({
          runId: row.task_run_id,
          interactionId: row.id,
        }), "task-run ACP interaction cancellation failed");
        interaction = rowToAcpInteraction(interactionOr404(db, row.id));
        if (interaction.state === "pending") {
          throw routeError("task-run ACP interaction cancellation was not accepted", {
            code: "interaction_delivery_failed",
            status: 502,
          });
        }
      }
      if (owner) acpUrlHandoffStore?.remove?.(row.id, owner);
      res.json({ interaction });
    } catch (error) {
      sendError(res, error);
    }
  });
}
