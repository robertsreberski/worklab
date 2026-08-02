import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import {
  acpEndpointUnsupported,
  acpOperationCancellable,
  acpOperationFinished,
  acpOperationId,
  acpProfileForAgent,
  externalAgentDraft,
  externalEnvKeysValid,
  externalAgentMutationPayload,
  externalAgentSlugValid,
  normalizeAcpProfile,
  UNSUPPORTED_ACP_CLIENT_CAPABILITIES,
} from "../lib/externalAgents.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { useUnsavedChangesGuard } from "../lib/navigation.js";
import { MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { EntityChromeBridge } from "../components/EntityChromeBridge.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { ExternalAgentBadge } from "../components/external-agents/ExternalAgentBadge.jsx";
import { AcpHealthCard } from "../components/external-agents/AcpHealthCard.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { EntityEditorModals } from "./EntityEditorModals.jsx";

const EXTERNAL_AGENT_SECTIONS = [
  { id: "external-agent-identity", num: "01", label: "Identity", meta: "Agent" },
  { id: "external-agent-launch", num: "02", label: "Launch", meta: "stdio" },
  { id: "external-agent-ownership", num: "03", label: "Ownership", meta: "Boundaries" },
  { id: "external-agent-policy", num: "04", label: "Permissions", meta: "Client policy" },
];

const OWNER_OPTIONS = [
  { value: "client", label: "Worklab", description: "Configured and enforced by this Worklab instance." },
  { value: "agent", label: "External agent", description: "Managed by the external agent and shown read-only here." },
];

const SESSION_RESUME_OPTIONS = [
  { value: "auto", label: "Automatic", description: "Resume when possible; otherwise load or create a session." },
  { value: "load", label: "Load", description: "Load the existing session through ACP." },
  { value: "resume", label: "Resume", description: "Resume the existing session through ACP." },
];

const OPAQUE_SESSION_RE = /^acp:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):[A-Za-z0-9_-]+$/u;
const OPAQUE_CURSOR_RE = /^acp-cursor:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):[A-Za-z0-9_-]+$/u;
const ACTIVE_OPERATION_STATES = new Set(["queued", "pending", "running", "waiting_for_interaction"]);

function operationState(operation) {
  return String(operation?.state || operation?.status || "").trim().toLowerCase();
}

function operationLabel(kind) {
  return ({
    probe: "Connection test",
    authenticate: "Authentication",
    logout: "Logout",
    list_sessions: "Session list",
    delete_session: "Session deletion",
  })[kind] || "ACP operation";
}

function operationSucceeded(operation) {
  return ["success", "succeeded", "complete", "completed"].includes(operationState(operation));
}

function operationList(result) {
  return Array.isArray(result?.operations) ? result.operations.filter((operation) => (
    operation && typeof operation === "object" && Boolean(acpOperationId(operation))
  )) : [];
}

function opaqueTokenForProfile(value, pattern, profileId) {
  if (typeof value !== "string" || value.length > 5_600) return null;
  const match = pattern.exec(value);
  if (!match || (profileId && match[1] !== profileId)) return null;
  return value;
}

function normalizedSession(session, profileId) {
  if (!session || typeof session !== "object") return null;
  const id = opaqueTokenForProfile(session.id, OPAQUE_SESSION_RE, profileId);
  if (!id) return null;
  const safeDate = (value) => {
    if (typeof value !== "string" || !value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : value;
  };
  return {
    id,
    title: typeof session.title === "string" ? session.title : "",
    status: typeof session.status === "string" ? session.status : "",
    createdAt: safeDate(session.createdAt),
    updatedAt: safeDate(session.updatedAt),
  };
}

function normalizedSessionResult(operation, profileId) {
  if (!operationSucceeded(operation) || operation?.kind !== "list_sessions") return null;
  const result = operation.result && typeof operation.result === "object" ? operation.result : {};
  const sessions = Array.isArray(result.sessions)
    ? result.sessions.map((session) => normalizedSession(session, profileId)).filter(Boolean)
    : [];
  return {
    sessions,
    nextCursor: opaqueTokenForProfile(result.nextCursor, OPAQUE_CURSOR_RE, profileId),
    truncated: result.truncated === true,
  };
}

function operationCursor(operation, profileId) {
  return opaqueTokenForProfile(operation?.request?.cursor, OPAQUE_CURSOR_RE, profileId);
}

function createdAtNumber(operation) {
  const value = Number(operation?.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function operationTime(operation) {
  const value = operation?.completedAt || operation?.updatedAt || operation?.createdAt;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function operationSummary(operation) {
  if (operation?.error?.message) return operation.error.message;
  const result = operation?.result && typeof operation.result === "object" ? operation.result : {};
  if (operation?.kind === "list_sessions") {
    const count = Array.isArray(result.sessions) ? result.sessions.length : 0;
    return `${count} session${count === 1 ? "" : "s"} returned${result.nextCursor ? "; more available" : ""}.`;
  }
  if (operation?.kind === "delete_session") return result.deleted ? "Remote session deleted." : "Session deletion completed.";
  if (operation?.kind === "probe") {
    return [result.status, result.installedVersion || result.installed_version]
      .filter((value) => typeof value === "string" && value)
      .join(" · ");
  }
  if (typeof result.status === "string" && result.status) return result.status;
  return "";
}

export function restoreAcpSessionListing(operations = [], profileId = null) {
  const completed = operations
    .map((operation) => ({ operation, page: normalizedSessionResult(operation, profileId) }))
    .filter((entry) => entry.page)
    .sort((left, right) => createdAtNumber(left.operation) - createdAtNumber(right.operation));
  if (!completed.length) return { sessions: [], nextCursor: null, truncated: false, restored: false };

  const roots = completed.filter(({ operation }) => !operationCursor(operation, profileId));
  let current = roots.at(-1) || completed.at(-1);
  const chain = [current];
  const visited = new Set([acpOperationId(current.operation)]);
  while (current.page.nextCursor) {
    const next = completed.find(({ operation }) => (
      !visited.has(acpOperationId(operation))
      && createdAtNumber(operation) >= createdAtNumber(current.operation)
      && operationCursor(operation, profileId) === current.page.nextCursor
    ));
    if (!next) break;
    chain.push(next);
    visited.add(acpOperationId(next.operation));
    current = next;
  }
  const sessions = [];
  const seen = new Set();
  for (const { page } of chain) {
    for (const session of page.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }
  const chainStartedAt = createdAtNumber(chain[0].operation);
  const deletedIds = new Set(operations.flatMap((operation) => {
    if (operation?.kind !== "delete_session"
      || !operationSucceeded(operation)
      || createdAtNumber(operation) < chainStartedAt
      || operation?.result?.deleted === false) return [];
    const candidate = operation?.result?.id || operation?.request?.providerSessionId;
    const id = opaqueTokenForProfile(candidate, OPAQUE_SESSION_RE, profileId);
    return id ? [id] : [];
  }));
  const last = chain.at(-1).page;
  return {
    sessions: sessions.filter((session) => !deletedIds.has(session.id)),
    nextCursor: last.nextCursor,
    truncated: last.truncated,
    restored: true,
  };
}

export function recoverAcpManagementState(result = {}, profileId = null) {
  const operations = operationList(result);
  const activeOperation = operations.find((operation) => ACTIVE_OPERATION_STATES.has(operationState(operation))) || null;
  const coordinatorRestartOperation = operations.find((operation) => (
    operation?.error?.code === "coordinator_restarted"
  )) || null;
  return {
    operations,
    activeOperation,
    latestOperation: activeOperation || operations[0] || null,
    sessionListing: restoreAcpSessionListing(operations, profileId),
    coordinatorRestartOperation,
  };
}

export function externalAgentDraftValidation(draft = {}, { isNew = false, driver = "generic" } = {}) {
  const agentName = String(draft.agentName || "").trim();
  const displayName = String(draft.displayName || "").trim();
  const description = String(draft.description || "").trim();
  const canonicalWorkspace = String(draft.canonicalWorkspace || "").trim();
  const configurationOwner = draft.configurationOwner === "agent" ? "agent" : "client";
  const commandRequired = driver === "generic" && (isNew || configurationOwner === "client");
  const errors = {
    agentName: isNew && !externalAgentSlugValid(agentName)
      ? "Use a lowercase slug of 1–64 letters, numbers, or hyphens."
      : null,
    displayName: !displayName
      ? "Display name is required."
      : displayName.length > 200
        ? "Use at most 200 characters."
        : null,
    description: description.length > 2_000 ? "Use at most 2,000 characters." : null,
    configurationOwner: isNew && driver === "generic" && configurationOwner === "agent"
      ? "New generic profiles must keep launch configuration in Worklab."
      : null,
    command: commandRequired && !String(draft.command || "").trim().startsWith("/")
      ? "Use an absolute executable path."
      : null,
    cwd: configurationOwner === "client"
      && String(draft.cwd || "").trim()
      && !String(draft.cwd || "").trim().startsWith("/")
      ? "Use an absolute directory path."
      : null,
    workspace: draft.workspaceOwner === "agent" && !canonicalWorkspace
      ? "Canonical workspace is required when the external agent owns the workspace."
      : canonicalWorkspace && !canonicalWorkspace.startsWith("/")
        ? "Use an absolute directory path."
        : null,
    envKeys: configurationOwner === "client" && !externalEnvKeysValid(draft.envKeysText)
      ? "Use environment key names only; values and '=' are not accepted."
      : null,
    probeTimeout: !Number.isInteger(Number(draft.probeTimeoutMs))
      || Number(draft.probeTimeoutMs) < 1_000
      || Number(draft.probeTimeoutMs) > 300_000
      ? "Enter a timeout from 1,000 to 300,000 ms."
      : null,
    sessionMode: draft.sessionModeId
      && (draft.sessionModeId.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(draft.sessionModeId))
      ? "Use at most 200 characters without control characters."
      : null,
  };
  return { errors, valid: Object.values(errors).every((error) => !error) };
}

export function opaqueSessionReference(value) {
  const text = typeof value === "string" ? value : "";
  return text.length > 34 ? `${text.slice(0, 22)}…${text.slice(-8)}` : text;
}

function emptyDraft() {
  return externalAgentDraft({ profile: { driver: "generic" } });
}

function profileBody(result) {
  return result?.profile || result || null;
}

function operationBody(result) {
  return result?.operation || result || null;
}

function resultAgentName(result, fallback) {
  return result?.agent?.name
    || result?.profile?.agent?.name
    || result?.profile?.agentName
    || result?.profile?.agent_name
    || fallback;
}

function profileIdFromAgent(agent) {
  return agent?.acpProfileId || agent?.acp_profile_id || agent?.externalProfileId || agent?.external_profile_id || null;
}

export function ExternalAgentEdit({ name, onSaved, onDeleted }) {
  const isNew = name === "new";
  const [agentResource, setAgentResource] = useState(null);
  const [profile, setProfile] = useState(null);
  const [draft, setDraft] = useState(() => emptyDraft());
  const [baseline, setBaseline] = useState(() => isNew ? emptyDraft() : null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [managementOperation, setManagementOperation] = useState(null);
  const [operationHistory, setOperationHistory] = useState([]);
  const [operationContext, setOperationContext] = useState(null);
  const [operationNotice, setOperationNotice] = useState("");
  const [probing, setProbing] = useState(false);
  const [authenticatingMethodId, setAuthenticatingMethodId] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [listingSessions, setListingSessions] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionsNextCursor, setSessionsNextCursor] = useState(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState(null);
  const [pendingSessionDeleteId, setPendingSessionDeleteId] = useState(null);
  const [cancellingOperation, setCancellingOperation] = useState(false);
  const pollTimerRef = useRef(null);

  const update = useCallback((patch) => setDraft((current) => ({ ...current, ...patch })), []);

  const load = useCallback(async ({ preserveDraft = false } = {}) => {
    if (isNew) {
      const next = emptyDraft();
      setDraft(next);
      setBaseline(next);
      setProfile(null);
      setAgentResource(null);
      setManagementOperation(null);
      setOperationHistory([]);
      setSessions([]);
      setSessionsNextCursor(null);
      setSessionsLoaded(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setUnsupported(false);
    try {
      const agentResult = await api.getAgent(name);
      const agent = agentResult?.agent || null;
      setAgentResource(agent);
      let rawProfile = agentResult?.profile || agent?.acpProfile || agent?.acp_profile || null;
      const profileId = profileIdFromAgent(agent) || rawProfile?.id;
      if (profileId) {
        const result = await api.getAcpProfile(profileId);
        rawProfile = profileBody(result);
      } else {
        const listed = await api.listAcpProfiles();
        const summary = acpProfileForAgent(listed?.profiles || [], name);
        if (summary?.id) {
          const result = await api.getAcpProfile(summary.id);
          rawProfile = profileBody(result);
        } else {
          rawProfile = summary;
        }
      }
      if (!rawProfile) throw new Error("No ACP profile is bound to this agent.");
      setProfile(rawProfile);
      if (!preserveDraft) {
        const next = externalAgentDraft({ agent, profile: rawProfile });
        setDraft(next);
        setBaseline(next);
      }
      await hydrateOperationHistory(rawProfile.id);
    } catch (err) {
      if (acpEndpointUnsupported(err)) setUnsupported(true);
      else setLoadError(err?.message || "External agent unavailable");
    } finally {
      setLoading(false);
    }
  }, [isNew, name]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  const formSave = useFormSave(async () => {
    const driver = normalizeAcpProfile(profile || {}).driver || draft.driver || "generic";
    const validation = externalAgentDraftValidation(draft, { isNew, driver });
    if (!validation.valid) {
      throw new Error(Object.values(validation.errors).find(Boolean) || "External agent configuration is invalid.");
    }
    const payload = externalAgentMutationPayload(draft, profile);
    const result = isNew
      ? await api.createAcpProfile(payload)
      : await api.patchAcpProfile(profile.id, payload);
    const savedProfile = profileBody(result);
    const savedAgent = result?.agent || savedProfile?.agent || agentResource;
    const next = externalAgentDraft({ agent: savedAgent, profile: savedProfile });
    setAgentResource(savedAgent || agentResource);
    setProfile(savedProfile);
    setDraft(next);
    setBaseline(next);
    pushToast(isNew ? "External agent created" : "Saved.", { variant: "success" });
    onSaved?.(resultAgentName(result, savedProfile?.agentName || draft.agentName || name));
  });

  const isDirty = useMemo(() => baseline ? JSON.stringify(draft) !== JSON.stringify(baseline) : false, [baseline, draft]);
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });
  const cancel = useCallback(() => guard.requestNavigation("#/library/agents"), [guard.requestNavigation]);

  useGlobalShortcuts({
    cmds: (event) => { event.preventDefault(); formSave.save().catch(() => {}); },
    Escape: cancel,
  });

  function contextForOperation(operation, profileId = profile?.id) {
    return {
      profileId,
      kind: operation?.kind || "probe",
      authMethodId: operation?.request?.authMethodId || null,
      append: Boolean(operationCursor(operation, profileId)),
      sessionId: operation?.request?.providerSessionId || null,
    };
  }

  function setOperationBusy(context, busy) {
    const value = busy === true;
    if (context.kind === "probe") setProbing(value);
    if (context.kind === "authenticate") setAuthenticatingMethodId(value ? context.authMethodId : null);
    if (context.kind === "logout") setLoggingOut(value);
    if (context.kind === "list_sessions") setListingSessions(value);
    if (context.kind === "delete_session") setDeletingSessionId(value ? context.sessionId : null);
  }

  function putOperationInHistory(operation) {
    if (!acpOperationId(operation)) return;
    setOperationHistory((current) => [
      operation,
      ...current.filter((candidate) => acpOperationId(candidate) !== acpOperationId(operation)),
    ].sort((left, right) => createdAtNumber(right) - createdAtNumber(left)));
  }

  async function refreshVolatileProfile(profileId = profile?.id) {
    if (!profileId) return;
    try {
      const result = await api.getAcpProfile(profileId);
      setProfile(profileBody(result));
    } catch {
      // A failed refresh must not replace an otherwise usable saved profile.
    }
  }

  async function refreshOperationHistory(profileId = profile?.id) {
    if (!profileId) return [];
    try {
      const result = await api.listAcpProfileOperations(profileId, { limit: 50 });
      const operations = operationList(result);
      setOperationHistory(operations);
      return operations;
    } catch {
      return [];
    }
  }

  async function hydrateOperationHistory(profileId) {
    try {
      const result = await api.listAcpProfileOperations(profileId, { limit: 50 });
      const recovered = recoverAcpManagementState(result, profileId);
      const { operations } = recovered;
      setOperationHistory(operations);
      const restored = recovered.sessionListing;
      if (restored.restored) {
        setSessions(restored.sessions);
        setSessionsNextCursor(restored.nextCursor);
        setSessionsLoaded(true);
      }
      const active = recovered.activeOperation;
      setManagementOperation(recovered.latestOperation);
      const restarted = recovered.coordinatorRestartOperation;
      if (restarted) {
        setOperationNotice(restarted.error.message || "Worklab restarted before an ACP operation completed.");
      }
      if (active) {
        const context = contextForOperation(active, profileId);
        setOperationContext(context);
        setOperationBusy(context, true);
        setOperationNotice(`Resumed monitoring the active ${operationLabel(active.kind).toLowerCase()} operation.`);
        pollOperation(acpOperationId(active), context);
      }
    } catch (error) {
      setOperationNotice(`ACP operation history could not be loaded: ${error.message}`);
    }
  }

  async function finishOperation(operation, context) {
    setManagementOperation(operation);
    putOperationInHistory(operation);
    setOperationContext(null);
    setCancellingOperation(false);
    setOperationBusy(context, false);

    const state = operationState(operation);
    const cancelled = ["cancelled", "canceled"].includes(state);
    const failed = ["failed", "error"].includes(state);
    const restarted = operation?.error?.code === "coordinator_restarted";
    const label = operationLabel(context.kind);
    if (restarted) {
      setOperationNotice(operation.error.message || "Worklab restarted before the ACP operation completed.");
    } else if (failed) {
      setOperationNotice(operation?.error?.message || `${label} failed.`);
    } else if (cancelled) {
      setOperationNotice(`${label} cancelled.`);
    } else {
      setOperationNotice(`${label} completed.`);
    }

    if (["probe", "authenticate", "logout"].includes(context.kind)) {
      await refreshVolatileProfile(context.profileId);
    }
    if (context.kind === "list_sessions" && operationSucceeded(operation)) {
      const page = normalizedSessionResult(operation, context.profileId);
      if (page) {
        setSessions((current) => {
          const candidates = context.append ? [...current, ...page.sessions] : page.sessions;
          return [...new Map(candidates.map((session) => [session.id, session])).values()];
        });
        setSessionsNextCursor(page.nextCursor);
        setSessionsLoaded(true);
      }
    }
    if (context.kind === "delete_session" && operationSucceeded(operation)) {
      setSessions((current) => current.filter((session) => session.id !== context.sessionId));
      setPendingSessionDeleteId(null);
    }
    await refreshOperationHistory(context.profileId);
    pushToast(
      restarted ? "ACP operation interrupted by Worklab restart" : `${label} ${cancelled ? "cancelled" : failed ? "failed" : "completed"}`,
      { variant: failed || restarted ? "error" : "success" },
    );
  }

  function pollOperation(id, context, retry = 0) {
    if (!id) return;
    pollTimerRef.current = setTimeout(async () => {
      try {
        const result = await api.getAcpOperation(id);
        const operation = operationBody(result);
        setManagementOperation(operation);
        putOperationInHistory(operation);
        if (acpOperationFinished(operation)) await finishOperation(operation, context);
        else pollOperation(id, context);
      } catch (err) {
        if (retry < 3) {
          setOperationNotice(`Reconnecting to ${operationLabel(context.kind).toLowerCase()} status…`);
          pollOperation(id, context, retry + 1);
          return;
        }
        setOperationContext(null);
        setCancellingOperation(false);
        setOperationBusy(context, false);
        setOperationNotice(`${operationLabel(context.kind)} status could not be refreshed: ${err.message}`);
        pushToast(`${operationLabel(context.kind)} status failed: ${err.message}`, { variant: "error" });
      }
    }, retry ? 1_200 : 800);
  }

  async function startOperation(context, start) {
    if (!context.profileId) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setOperationBusy(context, true);
    setCancellingOperation(false);
    setOperationNotice(`${operationLabel(context.kind)} started.`);
    try {
      const result = await start();
      const operation = operationBody(result);
      setManagementOperation(operation);
      putOperationInHistory(operation);
      const id = acpOperationId(operation);
      if (id && !acpOperationFinished(operation)) {
        setOperationContext(context);
        pollOperation(id, context);
      } else {
        await finishOperation(operation, context);
      }
    } catch (err) {
      setOperationContext(null);
      setOperationBusy(context, false);
      setOperationNotice(`${operationLabel(context.kind)} failed to start: ${err.message}`);
      pushToast(`${operationLabel(context.kind)} failed: ${err.message}`, { variant: "error" });
    }
  }

  function probe() {
    const profileId = profile?.id;
    return startOperation({ profileId, kind: "probe" }, () => api.probeAcpProfile(profileId));
  }

  function authenticate(authMethodId) {
    const profileId = profile?.id;
    if (!authMethodId) return undefined;
    return startOperation(
      { profileId, kind: "authenticate", authMethodId },
      () => api.authenticateAcpProfile(profileId, authMethodId),
    );
  }

  function logout() {
    const profileId = profile?.id;
    return startOperation({ profileId, kind: "logout" }, () => api.logoutAcpProfile(profileId));
  }

  function listSessions(cursor = null) {
    const profileId = profile?.id;
    return startOperation(
      { profileId, kind: "list_sessions", append: Boolean(cursor) },
      () => api.listAcpProfileSessions(profileId, cursor ? { cursor } : {}),
    );
  }

  function deleteSession(sessionId) {
    const profileId = profile?.id;
    return startOperation(
      { profileId, kind: "delete_session", sessionId },
      () => api.deleteAcpProfileSession(profileId, sessionId),
    );
  }

  async function cancelOperation() {
    const id = acpOperationId(managementOperation);
    if (!id || !acpOperationCancellable(managementOperation)) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const context = operationContext || contextForOperation(managementOperation);
    setCancellingOperation(true);
    try {
      const result = await api.cancelAcpOperation(id);
      const operation = operationBody(result) || { ...managementOperation, status: "cancelling" };
      setManagementOperation(operation);
      if (acpOperationFinished(operation)) {
        await finishOperation(operation, context);
      } else {
        setOperationContext(context);
        pollOperation(id, context);
        pushToast("ACP operation cancellation requested", { variant: "success" });
      }
    } catch (err) {
      setCancellingOperation(false);
      pollOperation(id, context);
      pushToast(`Operation cancellation failed: ${err.message}`, { variant: "error" });
    }
  }

  async function destroy() {
    if (!profile?.id) return;
    try {
      await api.deleteAcpProfile(profile.id);
      pushToast("External agent deleted", { variant: "success" });
      onDeleted?.();
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  if (loading) return <LoadingState caption="Loading external agent…" />;

  const normalizedProfile = normalizeAcpProfile(profile || {});
  const isMono = (profile ? normalizedProfile.driver : draft.driver) === "mono";
  const runtimeIdentityLocked = !isNew && !isMono;
  const agentManaged = draft.configurationOwner === "agent";
  const workspaceManaged = draft.workspaceOwner === "agent";
  const validation = externalAgentDraftValidation(draft, {
    isNew,
    driver: isMono ? "mono" : "generic",
  });
  const title = isNew ? "New external agent" : (draft.displayName || draft.agentName || name);
  const canSave = validation.valid && !unsupported;
  const saveButtonLabel = isNew ? "Create" : "Save";
  const saveButtonVariant = isDirty || isNew ? "primary" : "secondary";
  const headerActions = (
    <>
      {!isNew && <StatusPill status={draft.enabled ? "enabled" : "disabled"} />}
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button variant={saveButtonVariant} loading={formSave.saving} disabled={!canSave} onClick={() => formSave.save().catch(() => {})}>
        {saveButtonLabel}
      </Button>
    </>
  );
  const mobileActionDock = (
    <>
      <Button variant="secondary" onClick={cancel}>Cancel</Button>
      <Button variant={saveButtonVariant} loading={formSave.saving} disabled={!canSave} onClick={() => formSave.save().catch(() => {})}>
        {saveButtonLabel}
      </Button>
    </>
  );
  const managementActive = acpOperationCancellable(managementOperation);
  const coordinatorRestartOperation = operationHistory.find((operation) => (
    operation?.error?.code === "coordinator_restarted"
  ));

  function renderSessionsCard() {
    if (isNew) return null;
    return (
      <Card
        variant="spacious"
        title="ACP sessions"
        headerRight={listingSessions ? <StatusPill status="running" label="Loading" size="sm" /> : null}
        class="entity-rail-card acp-sessions-card"
      >
        <div class="acp-session-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => listSessions()}
            loading={listingSessions && !operationContext?.append}
            disabled={managementActive}
          >
            {sessionsLoaded ? "Refresh sessions" : "List sessions"}
          </Button>
        </div>
        {sessions.length > 0 ? (
          <ul class="acp-session-list" aria-label="Opaque ACP sessions">
            {sessions.map((session) => (
              <li class="acp-session-row" key={session.id}>
                <div class="acp-session-copy">
                  <strong>{session.title || "Untitled session"}</strong>
                  <code title={session.id}>{opaqueSessionReference(session.id)}</code>
                  {(session.status || session.updatedAt) && (
                    <small>{[session.status, session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ""].filter(Boolean).join(" · ")}</small>
                  )}
                </div>
                {pendingSessionDeleteId === session.id ? (
                  <div class="acp-session-delete-confirm" role="group" aria-label={`Confirm deletion of ${session.title || "untitled session"}`}>
                    <Button size="sm" variant="ghost" onClick={() => setPendingSessionDeleteId(null)}>Cancel</Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      loading={deletingSessionId === session.id}
                      disabled={managementActive && deletingSessionId !== session.id}
                      onClick={() => deleteSession(session.id)}
                    >
                      Confirm delete
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={managementActive}
                    onClick={() => setPendingSessionDeleteId(session.id)}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div class="acp-health-empty">
            {sessionsLoaded ? "No sessions were reported." : "List sessions to inspect opaque ACP references."}
          </div>
        )}
        {sessionsNextCursor && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => listSessions(sessionsNextCursor)}
            loading={listingSessions && operationContext?.append}
            disabled={managementActive}
          >
            Load more
          </Button>
        )}
      </Card>
    );
  }

  function renderOperationHistory() {
    if (isNew) return null;
    return (
      <Card variant="spacious" title="Recent ACP activity" class="entity-rail-card acp-operation-history-card">
        {coordinatorRestartOperation && (
          <Banner
            variant="error"
            title="Operation interrupted by Worklab restart"
            detail={coordinatorRestartOperation.error.message || "Worklab restarted before the ACP operation completed."}
            dismissible={false}
          />
        )}
        {operationNotice && (
          <div class="acp-operation-notice" role="status" aria-live="polite" aria-atomic="true">
            {operationNotice}
          </div>
        )}
        {operationHistory.length > 0 ? (
          <ol class="acp-operation-history" aria-label="Recent sanitized ACP operations">
            {operationHistory.slice(0, 8).map((operation) => (
              <li key={acpOperationId(operation)}>
                <div class="acp-operation-history-heading">
                  <strong>{operationLabel(operation.kind)}</strong>
                  <StatusPill status={operationState(operation)} size="sm" />
                </div>
                {operationSummary(operation) && <span>{operationSummary(operation)}</span>}
                {operationTime(operation) && <time>{operationTime(operation)}</time>}
              </li>
            ))}
          </ol>
        ) : (
          <div class="acp-health-empty">No ACP management operations yet.</div>
        )}
      </Card>
    );
  }

  function renderRail() {
    return (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="External runtime" class="entity-rail-card">
          <EntityMetaList items={[
            !isNew ? { label: "Agent", value: draft.agentName || name } : null,
            profile?.id ? { label: "Profile", value: profile.id } : null,
            { label: "Protocol", value: "ACP v1 over stdio", mono: false },
            { label: "Driver", value: normalizedProfile.driver || "generic", mono: false },
            normalizedProfile.monoSourceId ? { label: "Source", value: normalizedProfile.monoSourceId } : null,
            !agentManaged && draft.command ? { label: "Command", value: draft.command } : null,
          ].filter(Boolean)} />
        </Card>
        <Card variant="spacious" title="Ownership" class="entity-rail-card">
          <EntityMetaList items={[
            { label: "Configuration", value: draft.configurationOwner === "agent" ? "External agent" : "Worklab", mono: false },
            { label: "Workspace", value: draft.workspaceOwner === "agent" ? "External agent" : "Worklab", mono: false },
            { label: "MCP", value: draft.mcpOwner === "agent" ? "External agent" : "Worklab", mono: false },
          ]} />
        </Card>
        <AcpHealthCard
          profile={profile}
          operation={managementOperation}
          probing={probing}
          onProbe={probe}
          canProbe={!isNew && !!profile?.id}
          onAuthenticate={!isNew && profile?.id ? authenticate : undefined}
          authenticatingMethodId={authenticatingMethodId}
          onLogout={!isNew && profile?.id ? logout : undefined}
          loggingOut={loggingOut}
          onCancelOperation={cancelOperation}
          cancellingOperation={cancellingOperation}
          statusMessage={operationNotice}
        />
        {renderSessionsCard()}
        {renderOperationHistory()}
        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }} class="entity-rail-card">
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>Delete agent</Button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <>
      <EntityChromeBridge chrome={{
        mobileTopbar: <MobileTopbar title={isNew ? "New external agent" : draft.agentName || name} backLabel="Agents" onBack={cancel} />,
        mobileActionDock,
        drawerTitle: "External agent",
        drawerKicker: isNew ? "New" : draft.agentName || name,
        drawerContent: renderRail(),
        sections: EXTERNAL_AGENT_SECTIONS,
      }} />
      <DetailHead
        class="agent-detail-head entity-edit-head external-agent-detail-head"
        backLabel="All agents"
        onBack={cancel}
        crumbs={[{ label: "Agents", href: "#/library/agents" }, { label: isNew ? "New external" : "Edit" }]}
        icon={!isNew ? <AgentAvatar name={draft.agentName || name} label={draft.displayName || name} size={36} /> : null}
        iconFrame={false}
        kicker={isNew ? "Create external agent" : "Agent"}
        title={title}
        meta={<ExternalAgentBadge driver={normalizedProfile.driver || "generic"} />}
        actions={headerActions}
        subBar={<MobilePillRow railLabel="Status" railCount={isNew ? 3 : 6} sections={EXTERNAL_AGENT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body agent-detail-body">
        {unsupported && (
          <Banner variant="info" title="External agents are not supported by this server" detail="Upgrade or restart Worklab after the ACP profile routes are installed." dismissible={false} />
        )}
        {loadError && <Banner variant="error" title="External agent could not be loaded" detail={loadError} actions={<Button size="sm" onClick={() => load()}>Retry</Button>} dismissible={false} />}
        {formSave.error && <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} dismissible={false} />}
        <div class="entity-editor-layout agent-editor-layout external-agent-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="external-agent-identity" num="01" kicker="Identity" meta="Agent" />
            <FormSection kicker="Identity" title="Profile">
              <FormGrid columns={3} class="agent-profile-grid">
                <FormField
                  label="Agent slug"
                  required
                  hint={isNew ? "Permanent lowercase id; 1–64 letters, numbers, or hyphens." : "Permanent after creation."}
                  error={validation.errors.agentName}
                >
                  <Input
                    aria-label="Agent slug"
                    value={draft.agentName}
                    placeholder="my-external-agent"
                    disabled={!isNew}
                    readOnly={!isNew}
                    invalid={Boolean(validation.errors.agentName)}
                    onInput={(event) => update({ agentName: event.currentTarget.value })}
                  />
                </FormField>
                <FormField label="Display name" required error={validation.errors.displayName}>
                  <Input aria-label="Display name" value={draft.displayName} invalid={Boolean(validation.errors.displayName)} onInput={(event) => update({ displayName: event.currentTarget.value })} />
                </FormField>
                <FormField label="Description" error={validation.errors.description}>
                  <Input aria-label="Description" value={draft.description} invalid={Boolean(validation.errors.description)} onInput={(event) => update({ description: event.currentTarget.value })} />
                </FormField>
              </FormGrid>
              <FormGrid columns={1}>
                <FormField switchInside class="agent-availability-field">
                  <Switch checked={draft.enabled} onChange={(enabled) => update({ enabled })} label="Available for assignment" description="Disabled agents remain configured but cannot be assigned." />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="external-agent-launch" num="02" kicker="Launch" meta="stdio" />
            <FormSection kicker="Launch" title="ACP process" description="Worklab starts the executable directly and keeps stdout reserved for ACP JSON-RPC messages.">
              {runtimeIdentityLocked && (
                <Banner
                  variant="info"
                  title="Runtime identity is locked"
                  detail="Command, arguments, environment keys, launch directory, ownership, workspace, and session policy cannot change after creation. Recreate this external agent to use a different runtime identity."
                  dismissible={false}
                />
              )}
              {agentManaged && !runtimeIdentityLocked ? (
                <Banner
                  variant="info"
                  title="Launch configuration is agent-owned"
                  detail="Command, arguments, environment keys, and launch directory are managed by the external agent and intentionally hidden here."
                  dismissible={false}
                />
              ) : (
                <>
                  <FormField label="Command path" required error={validation.errors.command}>
                    <Input aria-label="Command path" value={draft.command} placeholder="/usr/local/bin/acp-agent" disabled={runtimeIdentityLocked} readOnly={runtimeIdentityLocked} invalid={Boolean(validation.errors.command)} onInput={(event) => update({ command: event.currentTarget.value })} />
                  </FormField>
                  <FormGrid columns={2}>
                    <FormField label="Arguments" hint="One argument per line. Worklab never invokes a shell. Credentials belong in Environment key names, never arguments.">
                      <Textarea aria-label="Arguments" rows={6} monospace value={draft.argsText} disabled={runtimeIdentityLocked} readOnly={runtimeIdentityLocked} onInput={(event) => update({ argsText: event.currentTarget.value })} />
                    </FormField>
                    <FormField label="Environment key names" hint="Names only, one per line. Values come from Worklab's process environment and are never shown here." error={validation.errors.envKeys}>
                      <Textarea aria-label="Environment key names" rows={6} monospace value={draft.envKeysText} placeholder="AGENT_TOKEN\nPATH" disabled={runtimeIdentityLocked} readOnly={runtimeIdentityLocked} aria-invalid={Boolean(validation.errors.envKeys)} onInput={(event) => update({ envKeysText: event.currentTarget.value })} />
                    </FormField>
                  </FormGrid>
                  <FormField label="Launch directory" hint="Optional absolute cwd used when starting the process." error={validation.errors.cwd}>
                    <Input aria-label="Launch directory" value={draft.cwd} placeholder="/workspace" disabled={runtimeIdentityLocked} readOnly={runtimeIdentityLocked} invalid={Boolean(validation.errors.cwd)} onInput={(event) => update({ cwd: event.currentTarget.value })} />
                  </FormField>
                </>
              )}
            </FormSection>

            <SectionMarker id="external-agent-ownership" num="03" kicker="Ownership" meta="Boundaries" />
            <FormSection kicker="Ownership" title="Control boundaries" description="Each boundary has exactly one authority. Agent-owned controls are not duplicated in Worklab.">
              <FormGrid columns={3}>
                <FormField label="Configuration" error={validation.errors.configurationOwner}>
                  <Select ariaLabel="Configuration owner" variant="native" value={draft.configurationOwner} options={OWNER_OPTIONS} disabled={isMono || runtimeIdentityLocked || isNew} onChange={(configurationOwner) => update({ configurationOwner })} />
                </FormField>
                <FormField label="Workspace">
                  <Select ariaLabel="Workspace owner" variant="native" value={draft.workspaceOwner} options={OWNER_OPTIONS} disabled={isMono || runtimeIdentityLocked} onChange={(workspaceOwner) => update({ workspaceOwner })} />
                </FormField>
                <FormField label="MCP servers">
                  <Select ariaLabel="MCP owner" variant="native" value={draft.mcpOwner} options={OWNER_OPTIONS} disabled={isMono || runtimeIdentityLocked} onChange={(mcpOwner) => update({ mcpOwner })} />
                </FormField>
              </FormGrid>
              {isMono && workspaceManaged ? (
                <Banner variant="info" title="Workspace is agent-owned" detail="The canonical workspace is supplied by the external agent and is intentionally read-only in Worklab." dismissible={false} />
              ) : (
                <FormField label="Canonical workspace" required={workspaceManaged} hint="Absolute root used to validate task workspaces and ACP session cwd; required when the external agent owns the workspace." error={validation.errors.workspace}>
                  <Input aria-label="Canonical workspace" value={draft.canonicalWorkspace} placeholder="/workspace" disabled={runtimeIdentityLocked} readOnly={runtimeIdentityLocked} invalid={Boolean(validation.errors.workspace)} onInput={(event) => update({ canonicalWorkspace: event.currentTarget.value })} />
                </FormField>
              )}
            </FormSection>

            <SectionMarker id="external-agent-policy" num="04" kicker="Permissions" meta="Client policy" />
            <FormSection kicker="Permissions" title="ACP client access" description="Worklab keeps unavailable ACP client services disabled and exposes only policies it can enforce.">
              {agentManaged && !runtimeIdentityLocked ? (
                <Banner
                  variant="info"
                  title={isMono ? "Mono capabilities are agent-owned" : "Permissions are agent-owned"}
                  detail="ACP client access and session settings are managed by the external profile and are read-only in Worklab."
                  dismissible={false}
                />
              ) : (
                <>
                  <Banner
                    variant="info"
                    title="Client services are unavailable"
                    detail="Filesystem, terminal, network, and client-supplied MCP services stay disabled in this Worklab version. Mono capabilities remain agent-owned."
                    dismissible={false}
                  />
                  <FormGrid columns={2}>
                    {UNSUPPORTED_ACP_CLIENT_CAPABILITIES.map((capability) => (
                      <FormField switchInside key={capability.id}>
                        <Switch checked={false} disabled label={capability.label} description={capability.description} />
                      </FormField>
                    ))}
                  </FormGrid>
                  <Banner
                    variant="info"
                    title="Opaque configuration is reserved"
                    detail="Worklab always submits an empty generic configuration policy. Reference credentials only by Environment key name; secret values are never accepted in this editor."
                    dismissible={false}
                  />
                  <FormGrid columns={2}>
                    <FormField label="Session resume strategy" hint="Choose how Worklab reuses an existing ACP session.">
                      <Select ariaLabel="Session resume strategy" variant="native" value={draft.sessionResumeStrategy} options={SESSION_RESUME_OPTIONS} disabled={runtimeIdentityLocked} onChange={(sessionResumeStrategy) => update({ sessionResumeStrategy })} />
                    </FormField>
                    <FormField label="Session mode id" hint="Optional agent-advertised mode identifier; maximum 200 characters." error={validation.errors.sessionMode}>
                      <Input aria-label="Session mode id" value={draft.sessionModeId} maxLength={200} disabled={runtimeIdentityLocked} readOnly={runtimeIdentityLocked} invalid={Boolean(validation.errors.sessionMode)} onInput={(event) => update({ sessionModeId: event.currentTarget.value })} />
                    </FormField>
                  </FormGrid>
                </>
              )}
              {!isMono && (
                <FormField label="Probe timeout (ms)" hint="1,000–300,000 ms. Default 30,000. This safety deadline can be changed without replacing the runtime identity." error={validation.errors.probeTimeout}>
                  <Input aria-label="Probe timeout" type="number" min={1000} max={300000} value={String(draft.probeTimeoutMs)} invalid={Boolean(validation.errors.probeTimeout)} onInput={(event) => update({ probeTimeoutMs: Number(event.currentTarget.value) || 0 })} />
                </FormField>
              )}
            </FormSection>
          </main>
          <aside class="entity-editor-rail is-mobile-drawer-source">{renderRail()}</aside>
        </div>
      </div>
      <EntityEditorModals
        deleteOpen={deleteOpen}
        setDeleteOpen={setDeleteOpen}
        deleteTitle={`Delete "${draft.displayName || draft.agentName || name}"?`}
        deleteMessage="This removes the external profile and its Agent resource. Existing task references must be reassigned."
        onDelete={destroy}
        guard={guard}
        saving={formSave.saving}
      />
    </>
  );
}
