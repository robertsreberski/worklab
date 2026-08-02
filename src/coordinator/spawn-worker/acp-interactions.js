import {
  cancelAcpInteraction,
  claimAcpInteractionResponse,
  expirePendingAcpInteractionsForRun,
  finalizeAcpInteractionResponse,
  getAcpInteractionById,
  insertAcpInteractionRequest,
  releaseAcpInteractionResponse,
} from "../../core/db/queries/acp-interactions.js";

export function persistAcpInteractionRequest(db, runId, event) {
  const request = event.request && typeof event.request === "object" ? event.request : {};
  const kind = event.interaction_kind === "permission"
    ? "permission"
    : request.mode === "url" ? "url" : "form";
  const at = Number(event.ts) || Date.now();
  insertAcpInteractionRequest(db, {
    id: String(event.interaction_id),
    profileId: String(event.profile_id || ""),
    taskRunId: runId,
    protocolRequestId: String(event.protocol_request_id || event.interaction_id),
    kind,
    requestSchemaJson: JSON.stringify(request),
    createdAt: at,
    updatedAt: at,
  });
}

export function createAcpInteractionControls({ db, runId, writeControlMessage, emitEvent }) {
  async function respond({ interactionId, response, disposition } = {}) {
    const existing = interactionId ? getAcpInteractionById(db, interactionId) : null;
    if (!existing || existing.task_run_id !== runId) {
      return { ok: false, code: "no_pending_interaction", message: "ACP interaction is not pending for this run" };
    }
    let claimed;
    try {
      claimed = claimAcpInteractionResponse(db, interactionId, { disposition });
    } catch {
      return { ok: false, code: "invalid_response", message: "ACP interaction response is invalid" };
    }
    if (!claimed) {
      return { ok: false, code: "no_pending_interaction", message: "ACP interaction is not pending" };
    }
    try {
      await writeControlMessage({ type: "acp_interaction_response", interaction_id: interactionId, response });
    } catch (err) {
      releaseAcpInteractionResponse(db, interactionId);
      return { ok: false, code: "delivery_failed", message: err?.message || "failed to deliver ACP interaction response" };
    }
    const row = finalizeAcpInteractionResponse(db, interactionId);
    emitEvent({
      type: "acp_interaction_resolved",
      interaction_id: interactionId,
      interaction_kind: existing.kind,
      disposition,
      ts: Date.now(),
    });
    return { ok: true, row };
  }

  async function cancel({ interactionId } = {}) {
    const existing = interactionId ? getAcpInteractionById(db, interactionId) : null;
    if (!existing || existing.task_run_id !== runId) {
      return { ok: false, code: "no_pending_interaction", message: "ACP interaction is not pending for this run" };
    }
    const row = cancelAcpInteraction(db, interactionId);
    if (!row) {
      return { ok: false, code: "no_pending_interaction", message: "ACP interaction is not pending" };
    }
    try {
      await writeControlMessage({ type: "acp_interaction_cancel", interaction_id: interactionId });
    } catch (err) {
      return { ok: false, code: "delivery_failed", message: err?.message || "failed to cancel ACP interaction" };
    }
    emitEvent({
      type: "acp_interaction_resolved",
      interaction_id: interactionId,
      interaction_kind: existing.kind,
      disposition: "cancel",
      ts: Date.now(),
    });
    return { ok: true, row };
  }

  return { respond, cancel };
}

export function expireAcpInteractionsForRun(db, runId) {
  return expirePendingAcpInteractionsForRun(db, runId, { disposition: "run_ended" });
}

