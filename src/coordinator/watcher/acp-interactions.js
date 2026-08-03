function missingEntry() {
  return { ok: false, code: "run_not_active", message: "run is not active" };
}

function unsupported() {
  return { ok: false, code: "acp_interaction_unsupported", message: "worker does not accept ACP interactions" };
}

export function createAcpRunInteractionDispatcher(activeByRunId) {
  return {
    async sendRunAcpInteractionResponse({ runId, ...payload } = {}) {
      const entry = activeByRunId.get(runId);
      if (!entry) return missingEntry();
      if (typeof entry.handle?.sendAcpInteractionResponse !== "function") return unsupported();
      return entry.handle.sendAcpInteractionResponse(payload);
    },
    async sendRunAcpInteractionCancel({ runId, ...payload } = {}) {
      const entry = activeByRunId.get(runId);
      if (!entry) return missingEntry();
      if (typeof entry.handle?.sendAcpInteractionCancel !== "function") return unsupported();
      return entry.handle.sendAcpInteractionCancel(payload);
    },
  };
}
