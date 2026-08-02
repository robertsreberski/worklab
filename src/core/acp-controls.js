import {
  createMonoAcpDiscoveryControls,
  createWorklabAcpProfileResolver,
} from "./acp-runtime-profile.js";
import { normalizeAcpSessionCursor } from "./acp-operations.js";

function controlError(code, message) {
  return Object.assign(new Error(message), {
    code,
    publicMessage: message,
    safeMessage: message,
  });
}

function profileId(profile) {
  if (typeof profile?.id !== "string" || !profile.id) {
    throw controlError("profile_invalid", "ACP profile id is missing");
  }
  return profile.id;
}

function interactionKind(request) {
  if (request?.kind === "permission") return "permission";
  return request?.payload?.mode === "url" ? "url" : "form";
}

function protocolRequestId(request, context) {
  const value = context?.requestId
    ?? request?.payload?.requestId
    ?? request?.payload?.elicitationId;
  if (value == null || String(value).length === 0) {
    throw controlError("protocol_request_invalid", "ACP interaction request id is missing");
  }
  return String(value);
}

function publicInteractionPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { sessionId: _sessionId, session_id: _sessionIdSnake, ...payload } = value;
  return payload;
}

function permissionResponse(response) {
  if (response?.outcome?.outcome === "selected" && typeof response.outcome.optionId === "string") {
    return { outcome: { outcome: "selected", optionId: response.outcome.optionId } };
  }
  const optionId = response?.optionId || response?.option_id;
  if (typeof optionId === "string" && optionId) {
    return { outcome: { outcome: "selected", optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function elicitationResponse(response) {
  const action = response?.action || response?.disposition;
  if (action === "accept") {
    const content = Object.hasOwn(response || {}, "content")
      ? response.content
      : response?.values;
    return content === undefined ? { action: "accept" } : { action: "accept", content };
  }
  if (action === "decline") return { action: "decline" };
  return { action: "cancel" };
}

function interactionAdapter(onInteraction) {
  if (typeof onInteraction !== "function") return undefined;
  return async (request, context = {}) => {
    const kind = interactionKind(request);
    const response = await onInteraction({
      kind,
      protocolRequestId: protocolRequestId(request, context),
      requestSchema: publicInteractionPayload(request?.payload),
    });
    return kind === "permission"
      ? permissionResponse(response)
      : elicitationResponse(response);
  };
}

async function defaultRuntimeLoader() {
  return import("@mono-agent/agent-runtime");
}

function requiredRuntimeMethod(runtime, name) {
  if (typeof runtime?.[name] !== "function") {
    throw controlError(
      "runtime_incompatible",
      `Installed @mono-agent/agent-runtime does not provide ${name}`,
    );
  }
  return runtime[name];
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : controlError("cancelled", "ACP operation was cancelled");
}

/**
 * Compose Worklab's persisted ACP profiles and mono-agent discovery with the
 * shared @mono-agent/agent-runtime ACP client. Runtime loading is lazy so the
 * coordinator can still boot and report an actionable compatibility error
 * while an older package is installed.
 */
export function createWorklabAcpControls({
  db,
  env = process.env,
  agentRuntime = null,
  loadAgentRuntime = defaultRuntimeLoader,
  monoDiscoveryControls = null,
} = {}) {
  const resolveAcpProfile = createWorklabAcpProfileResolver({ db, env });
  const discovery = monoDiscoveryControls || createMonoAcpDiscoveryControls({ env });
  let runtimePromise = agentRuntime ? Promise.resolve(agentRuntime) : null;
  const runtime = () => {
    runtimePromise ||= Promise.resolve().then(() => loadAgentRuntime());
    return runtimePromise;
  };
  const runtimeOptions = ({ signal, onInteraction } = {}) => {
    const onAcpInteractionRequest = interactionAdapter(onInteraction);
    return {
      resolveAcpProfile,
      signal,
      ...(onAcpInteractionRequest ? { onAcpInteractionRequest } : {}),
    };
  };

  return {
    ...discovery,

    async probe({ profile, signal, onInteraction } = {}) {
      const client = await runtime();
      throwIfAborted(signal);
      const result = await requiredRuntimeMethod(client, "probeAcpProfile")(
        profileId(profile),
        runtimeOptions({ signal, onInteraction }),
      );
      return {
        ...result,
        ok: true,
        status: "ready",
        capabilities: result?.agentCapabilities || result?.capabilities || {},
      };
    },

    async authenticate({ profile, authMethodId, signal, onInteraction } = {}) {
      const client = await runtime();
      throwIfAborted(signal);
      return requiredRuntimeMethod(client, "authenticateAcpProfile")(
        profileId(profile),
        authMethodId,
        runtimeOptions({ signal, onInteraction }),
      );
    },

    async logout({ profile, signal, onInteraction } = {}) {
      const client = await runtime();
      throwIfAborted(signal);
      const result = await requiredRuntimeMethod(client, "logoutAcpProfile")(
        profileId(profile),
        runtimeOptions({ signal, onInteraction }),
      );
      return { ...result, status: result?.loggedOut === false ? "logout_failed" : "logged_out" };
    },

    async listSessions({ profile, cursor, signal, onInteraction } = {}) {
      const id = profileId(profile);
      const sessionCursor = normalizeAcpSessionCursor(cursor);
      const client = await runtime();
      throwIfAborted(signal);
      const boundProfile = await resolveAcpProfile(id);
      throwIfAborted(signal);
      const sessionCwd = boundProfile.workspaceOwner === "agent"
        ? boundProfile.workspacePath
        : null;
      return requiredRuntimeMethod(client, "listAcpSessions")(
        id,
        {
          ...(sessionCwd ? { cwd: sessionCwd } : {}),
          ...(sessionCursor ? { cursor: sessionCursor } : {}),
        },
        runtimeOptions({ signal, onInteraction }),
      );
    },

    async deleteSession({ profile, providerSessionId, remoteSessionId, signal, onInteraction } = {}) {
      const client = await runtime();
      throwIfAborted(signal);
      const opaqueSessionId = providerSessionId || remoteSessionId;
      const decoded = requiredRuntimeMethod(client, "decodeAcpProviderSessionId")(opaqueSessionId);
      if (decoded?.profileId !== profileId(profile)) {
        throw controlError("invalid_session_id", "ACP provider session belongs to a different profile");
      }
      return requiredRuntimeMethod(client, "deleteAcpSession")(
        opaqueSessionId,
        runtimeOptions({ signal, onInteraction }),
      );
    },
  };
}
