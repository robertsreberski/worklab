import {
  acpInteractionDisposition,
  createAcpProfile,
  deleteAcpProfileRecord,
  getAcpProfile,
  getAcpProfiles,
  normalizeMonoDiscovery,
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
    return await callback();
  } catch {
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

function startOperation(res, manager, profileId, kind, remoteSessionId = null) {
  if (!manager) {
    return sendError(res, routeError("ACP operation manager is not configured", {
      code: "not_configured",
      status: 501,
    }));
  }
  try {
    const operation = manager.start({ profileId, kind, remoteSessionId });
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
      res.json({ discovery: normalizeMonoDiscovery(discovery) });
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
  app.post("/api/acp/profiles/:id/authenticate", (req, res) => (
    startOperation(res, acpOperationManager, req.params.id, "authenticate")
  ));
  app.post("/api/acp/profiles/:id/logout", (req, res) => (
    startOperation(res, acpOperationManager, req.params.id, "logout")
  ));
  app.post("/api/acp/profiles/:id/sessions:list", (req, res) => (
    startOperation(res, acpOperationManager, req.params.id, "list_sessions")
  ));
  app.delete("/api/acp/profiles/:id/sessions/:sessionId", (req, res) => (
    startOperation(res, acpOperationManager, req.params.id, "delete_session", req.params.sessionId)
  ));

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

  app.post("/api/acp/interactions/:id/respond", async (req, res) => {
    try {
      const row = interactionOr404(db, req.params.id);
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
      res.json({ interaction });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/acp/interactions/:id/cancel", async (req, res) => {
    try {
      const row = interactionOr404(db, req.params.id);
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
      res.json({ interaction });
    } catch (error) {
      sendError(res, error);
    }
  });
}
