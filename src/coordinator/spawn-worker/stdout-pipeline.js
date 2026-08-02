import { createInterface } from "node:readline";

import { insertApprovalRequest } from "../../core/db/queries/task-run-approvals.js";
import {
  persistAcpInteractionRequest,
  sanitizeTaskRunAcpInteractionEvent,
  taskRunEventNeedsUrlHandoff,
} from "./acp-interactions.js";

function isWorklabResult(value) {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schema === "worklab.v2"
    && typeof value.decision === "string";
}

function worklabResultFromStructuredOutputEvent(rawEvent) {
  const event = rawEvent?.type === "sdk_event" && rawEvent.event ? rawEvent.event : rawEvent;
  if (event?.type !== "structured_output") return null;
  const candidates = [
    event.worklab_result,
    event.value,
    event.value?.worklab_result,
    rawEvent?.worklab_result,
  ];
  return candidates.find(isWorklabResult) || null;
}

function cancelInteraction(writeControlMessage, interactionId) {
  writeControlMessage({
    type: "acp_interaction_cancel",
    interaction_id: String(interactionId || ""),
  }).catch(() => {});
}

/**
 * Serializes stdout handling behind private fd3 URL registration. Keeping the
 * ordering here ensures later events in the same stdout chunk cannot overtake
 * URL component registration, and finalize() can wait for the complete queue.
 */
export function createAcpAwareStdoutPipeline({
  stream,
  acpProfileId,
  runId,
  db,
  broker,
  logger,
  acpUrlHandoffStore,
  acpUrlHandoffReceiver,
  acpInteractionControls,
  acpEventBoundary,
  emitEvent,
  mergeWorkerDiagnostics,
  writeControlMessage,
  state,
} = {}) {
  let processing = Promise.resolve();

  function processParsed(parsed) {
    const isAcpEvent = String(parsed?.type || "").startsWith("acp_")
      || (parsed?.type === "sdk_event" && String(parsed?.event?.type || "").startsWith("acp_"));
    if (isAcpEvent && !acpProfileId) {
      logger?.warn?.({ runId, reason: "acp_profile_missing" }, "ACP worker event rejected");
      return;
    }
    const isUrlInteraction = taskRunEventNeedsUrlHandoff(parsed);
    if (parsed.type === "acp_interaction_requested"
      && acpProfileId
      && parsed.profile_id !== acpProfileId) {
      acpUrlHandoffStore?.remove?.(String(parsed.interaction_id || ""), {
        ownerKind: "run",
        ownerId: runId,
        profileId: acpProfileId,
      });
      logger?.warn?.({ runId, reason: "profile_mismatch" }, "ACP interaction request rejected");
      cancelInteraction(writeControlMessage, parsed.interaction_id);
      return;
    }
    const urlPublicRequest = isUrlInteraction
      ? acpInteractionControls.publicUrlRequest(parsed.interaction_id)
      : null;
    if (isUrlInteraction && !urlPublicRequest) {
      logger?.warn?.({ runId, reason: "url_privacy_unavailable" }, "ACP interaction request rejected");
      cancelInteraction(writeControlMessage, parsed.interaction_id);
      return;
    }
    const safeParsed = acpProfileId
      ? acpInteractionControls.redactWorkerEvent(
        sanitizeTaskRunAcpInteractionEvent(acpEventBoundary.sanitizeWorkerEvent(parsed), {
          urlPublicRequest,
        }),
      )
      : parsed;
    if (safeParsed.type === "acp_interaction_requested" && safeParsed.interaction_id) {
      try {
        persistAcpInteractionRequest(db, runId, safeParsed, { profileId: acpProfileId });
      } catch (error) {
        logger?.warn?.({ err: error.message, runId }, "failed to persist ACP interaction request");
        cancelInteraction(writeControlMessage, safeParsed.interaction_id);
        return;
      }
    }
    const { rawEvent } = emitEvent(safeParsed);
    mergeWorkerDiagnostics(rawEvent.diagnostics);
    if (["final", "error", "cancelled", "worklab_result_error"].includes(rawEvent.type)) {
      const providerSessionId = acpEventBoundary.validateProviderSessionId(
        rawEvent.provider_session_id || rawEvent.providerSessionId,
      );
      if (providerSessionId) state.terminalProviderSessionId = providerSessionId;
    }
    const structuredResult = worklabResultFromStructuredOutputEvent(rawEvent);
    if (structuredResult) state.structuredOutputResult = structuredResult;
    if (rawEvent.type === "final") state.finalPayload = rawEvent;
    if (rawEvent.type === "error") {
      state.errorMessage = rawEvent.message;
      state.explicitFailureKind = rawEvent.failureKind
        || rawEvent.failure_kind
        || state.explicitFailureKind;
      if (rawEvent.details) state.errorDetails = rawEvent.details;
    }
    if (rawEvent.type === "cancelled") {
      state.cancelInitiator = state.cancelInitiator
        || rawEvent.initiator
        || rawEvent.cancel_initiator
        || null;
      state.cancelReason = state.cancelReason || rawEvent.reason || rawEvent.cancel_reason || null;
      state.workerCancelSignal = state.workerCancelSignal || rawEvent.signal || null;
      if (rawEvent.drained === true) state.drainAcknowledged = true;
    }
    if (rawEvent.type === "drained") state.drainAcknowledged = true;
    if (rawEvent.type === "worklab_result_error") {
      state.resultError = rawEvent.message || "invalid worklab_result";
      state.explicitFailureKind = "invalid_result";
    }
    if (rawEvent.type === "approval_requested" && rawEvent.request_id) {
      try {
        insertApprovalRequest(db, {
          taskRunId: runId,
          requestId: String(rawEvent.request_id),
          toolName: rawEvent.tool_name || rawEvent.toolName || "",
          toolUseId: rawEvent.tool_use_id || rawEvent.toolUseId || null,
          argumentsSummary: rawEvent.arguments_summary || rawEvent.argumentsSummary || "",
          riskTier: rawEvent.risk_tier || rawEvent.riskTier || "medium",
          model: rawEvent.model || null,
        });
        broker.broadcast(runId, {
          type: "approval_requested",
          request_id: String(rawEvent.request_id),
          tool_name: rawEvent.tool_name || rawEvent.toolName || "",
          risk_tier: rawEvent.risk_tier || rawEvent.riskTier || "medium",
        });
      } catch (error) {
        logger?.warn?.({ err: error.message, runId }, "failed to persist approval request");
      }
    }
    if (rawEvent.type === "acp_interaction_acknowledged" && rawEvent.interaction_id) {
      try {
        acpInteractionControls.handleWorkerEvent(rawEvent);
      } catch (error) {
        logger?.warn?.({ err: error.message, runId }, "failed to apply ACP interaction acknowledgement");
      }
    }
    if (rawEvent.type === "prompt_built" && rawEvent.diagnostics) {
      state.promptDiagnostics = { ...(state.promptDiagnostics || {}), ...rawEvent.diagnostics };
    }
  }

  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      logger?.warn?.({
        ...(acpProfileId ? { line_length: line.length } : { line }),
        err: error.message,
      }, "worker emitted malformed stdout");
      return;
    }
    processing = processing.then(async () => {
      if (taskRunEventNeedsUrlHandoff(parsed)) {
        if (await acpUrlHandoffReceiver.waitFor(parsed.interaction_id)) {
          processParsed(parsed);
          return;
        }
        emitEvent({
          type: "runtime_warning",
          warning_kind: "acp_url_handoff_unavailable",
          message: "ACP URL interaction was cancelled because its private handoff was unavailable.",
          ts: Date.now(),
        });
        cancelInteraction(writeControlMessage, parsed.interaction_id);
        return;
      }
      processParsed(parsed);
    }).catch(() => {
      logger?.warn?.({ runId, reason: "stdout_processing_failed" }, "ACP worker event rejected");
    });
  });

  return { whenIdle: () => processing };
}
