import {
  acpAuthMethods,
  acpOperationCancellable,
} from "../../lib/externalAgents.js";
import { Card } from "../Card.jsx";
import { Button } from "../primitives/Button.jsx";
import { StatusPill } from "../primitives/StatusPill.jsx";
import { EntityMetaList } from "../EntityMetaList.jsx";
import { Icon } from "../Icon.jsx";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function titleCase(value) {
  return text(value).replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function probeRecord(profile, operation) {
  const operationKind = text(operation?.kind).toLowerCase();
  if (operation && (!operationKind || operationKind === "probe")) return operation;
  return profile?.lastProbe || profile?.last_probe || null;
}

function normalizedTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function acpHealthView(profile = {}, operation = null) {
  const probe = probeRecord(profile, operation);
  const result = object(probe?.result);
  const state = text(probe?.state || probe?.status).toLowerCase();
  const reportedStatus = text(result.status).toLowerCase();
  const active = ["queued", "pending", "running", "probing", "waiting_for_interaction"].includes(state);
  const failed = ["failed", "error", "unhealthy", "offline", "cancelled", "canceled"].includes(state)
    || ["failed", "error", "unhealthy", "offline"].includes(reportedStatus);
  const complete = ["success", "succeeded", "healthy", "ready", "complete", "completed"].includes(state)
    || ["success", "succeeded", "healthy", "ready", "complete", "completed"].includes(reportedStatus);
  const status = active ? "running" : failed ? "failed" : complete ? "complete" : "disabled";
  const errorValue = object(probe?.error);
  const error = text(errorValue.message || probe?.error);
  const timestamp = normalizedTimestamp(
    probe?.completedAt || probe?.completed_at || probe?.updatedAt || probe?.updated_at || probe?.at,
  );
  return {
    status,
    label: active
      ? "Running"
      : failed
        ? "Failed"
        : titleCase(reportedStatus || state) || (profile ? "Not tested" : "Save to test"),
    result,
    capabilities: object(result.capabilities),
    agentInfo: object(result.agentInfo || result.agent_info),
    installedVersion: text(result.installedVersion || result.installed_version),
    protocolVersion: result.protocolVersion ?? result.protocol_version ?? null,
    bridgeVersion: result.bridgeVersion ?? result.bridge_version ?? null,
    authenticated: typeof result.authenticated === "boolean" ? result.authenticated : null,
    timestamp,
    error,
  };
}

function capabilityLabels(capabilities = null) {
  if (!capabilities || typeof capabilities !== "object") return [];
  const rawSession = capabilities.session || capabilities.sessions || capabilities.sessionCapabilities || capabilities.session_capabilities || {};
  const session = typeof rawSession === "object" ? rawSession : {};
  const prompt = capabilities.prompt || capabilities.promptCapabilities || capabilities.prompt_capabilities || {};
  return [
    capabilities.loadSession || capabilities.load_session ? "Load sessions" : null,
    rawSession === true ? "Sessions" : null,
    session.resume ? "Resume sessions" : null,
    session.list ? "List sessions" : null,
    session.delete ? "Delete sessions" : null,
    prompt.image ? "Images" : null,
    prompt.audio ? "Audio" : null,
    prompt.embeddedContext || prompt.embedded_context ? "Embedded context" : null,
    capabilities.terminal ? "Terminal" : null,
    capabilities.filesystem || capabilities.fs ? "Filesystem" : null,
  ].filter(Boolean);
}

export function AcpHealthCard({
  profile = null,
  operation = null,
  probing = false,
  onProbe,
  canProbe = true,
  onAuthenticate,
  authenticatingMethodId = null,
  onLogout,
  loggingOut = false,
  onCancelOperation,
  cancellingOperation = false,
  statusMessage = "",
}) {
  const view = acpHealthView(profile || {}, operation);
  const capabilities = capabilityLabels(view.capabilities);
  const info = view.agentInfo;
  const authMethods = acpAuthMethods(profile || {}, text(operation?.kind).toLowerCase() === "probe" ? operation : null);
  const operationActive = acpOperationCancellable(operation);
  const announcement = statusMessage
    || (probing ? "Testing ACP connection." : null)
    || (authenticatingMethodId ? "ACP authentication is in progress." : null)
    || (loggingOut ? "ACP logout is in progress." : null)
    || `ACP connection status: ${view.label}.`;

  return (
    <Card
      variant="spacious"
      title="ACP connection"
      headerRight={<StatusPill status={view.status} label={view.label} size="sm" />}
      class="entity-rail-card acp-health-card"
    >
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <EntityMetaList items={[
        info?.name || info?.title ? { label: "Agent", value: info.title || info.name, mono: false } : null,
        view.installedVersion || info?.version ? { label: "Version", value: view.installedVersion || info.version } : null,
        view.protocolVersion != null ? { label: "Protocol", value: `ACP ${view.protocolVersion}`, mono: false } : null,
        view.bridgeVersion != null ? { label: "Bridge", value: String(view.bridgeVersion) } : null,
        view.authenticated != null ? { label: "Authenticated", value: view.authenticated ? "Yes" : "No", mono: false } : null,
        view.timestamp ? { label: "Last probe", value: view.timestamp.toLocaleString(), mono: false } : null,
      ].filter(Boolean)} />
      {view.error && <div class="acp-health-error" role="alert" aria-live="assertive">{view.error}</div>}
      {capabilities.length > 0 ? (
        <div class="acp-capability-list" aria-label="Reported ACP capabilities">
          {capabilities.map((label) => <span key={label}>{label}</span>)}
        </div>
      ) : (
        <div class="acp-health-empty">Capabilities appear after a successful initialize probe.</div>
      )}
      {(authMethods.length > 0 || onLogout) && (
        <div class="acp-auth-methods" aria-label="Advertised authentication methods">
          <strong>Authentication</strong>
          {authMethods.map((method) => (
            <div class="acp-auth-method" key={method.id}>
              <div class="acp-auth-method-copy">
                <span>{method.label}</span>
                {(method.description || method.type) && <small>{method.description || method.type}</small>}
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Authenticate with ${method.label}`}
                loading={authenticatingMethodId === method.id}
                disabled={!onAuthenticate || operationActive || (!!authenticatingMethodId && authenticatingMethodId !== method.id)}
                onClick={() => onAuthenticate?.(method.id)}
              >
                Authenticate
              </Button>
            </div>
          ))}
          {onLogout && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onLogout}
              loading={loggingOut}
              disabled={operationActive || !!authenticatingMethodId}
            >
              Log out
            </Button>
          )}
        </div>
      )}
      <div class="acp-health-actions">
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Icon name="refresh-cw" size={13} />}
          onClick={onProbe}
          loading={probing || (view.status === "running" && text(operation?.kind).toLowerCase() === "probe")}
          disabled={!canProbe || operationActive}
        >
          Test connection
        </Button>
        {operationActive && (
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="stop" size={13} />}
            aria-label="Cancel active ACP operation"
            onClick={onCancelOperation}
            loading={cancellingOperation}
            disabled={!onCancelOperation}
          >
            Cancel operation
          </Button>
        )}
      </div>
    </Card>
  );
}
