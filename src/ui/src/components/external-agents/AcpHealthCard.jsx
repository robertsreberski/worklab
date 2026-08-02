import { acpAuthMethods, acpProbeStatus, externalAgentVolatileState } from "../../lib/externalAgents.js";
import { Card } from "../Card.jsx";
import { Button } from "../primitives/Button.jsx";
import { StatusPill } from "../primitives/StatusPill.jsx";
import { EntityMetaList } from "../EntityMetaList.jsx";
import { Icon } from "../Icon.jsx";

function probeValue(profile, operation) {
  return operation || profile?.lastProbe || profile?.last_probe || null;
}

function probeLabel(profile, operation) {
  const value = probeValue(profile, operation);
  return value?.status || value?.state || (profile ? "Not tested" : "Save to test");
}

function capabilityLabels(capabilities = null) {
  if (!capabilities || typeof capabilities !== "object") return [];
  const session = capabilities.session || capabilities.sessionCapabilities || capabilities.session_capabilities || {};
  const prompt = capabilities.prompt || capabilities.promptCapabilities || capabilities.prompt_capabilities || {};
  return [
    capabilities.loadSession || capabilities.load_session ? "Load sessions" : null,
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
}) {
  const volatile = externalAgentVolatileState(profile || {});
  const status = acpProbeStatus(profile || {}, operation);
  const probe = probeValue(profile, operation);
  const capabilities = capabilityLabels(volatile.capabilities || probe?.capabilities || probe?.agentCapabilities);
  const info = probe?.agentInfo || probe?.agent_info || profile?.agentInfo || profile?.agent_info || null;
  const timestamp = probe?.completedAt || probe?.completed_at || probe?.updatedAt || probe?.updated_at || probe?.at || null;
  const error = probe?.error?.message || probe?.error || probe?.message || null;
  const authMethods = acpAuthMethods(profile || {}, operation);

  return (
    <Card
      variant="spacious"
      title="ACP connection"
      headerRight={<StatusPill status={status} label={probeLabel(profile, operation)} size="sm" />}
      class="entity-rail-card acp-health-card"
    >
      <EntityMetaList items={[
        info?.name || info?.title ? { label: "Agent", value: info.title || info.name, mono: false } : null,
        info?.version ? { label: "Version", value: info.version } : null,
        timestamp ? { label: "Last probe", value: new Date(timestamp).toLocaleString(), mono: false } : null,
      ].filter(Boolean)} />
      {error && <div class="acp-health-error">{String(error)}</div>}
      {capabilities.length > 0 ? (
        <div class="acp-capability-list" aria-label="Reported ACP capabilities">
          {capabilities.map((label) => <span key={label}>{label}</span>)}
        </div>
      ) : (
        <div class="acp-health-empty">Capabilities appear after a successful initialize probe.</div>
      )}
      {authMethods.length > 0 && (
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
                disabled={!onAuthenticate || (!!authenticatingMethodId && authenticatingMethodId !== method.id)}
                onClick={() => onAuthenticate?.(method.id)}
              >
                Authenticate
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        variant="secondary"
        size="sm"
        iconLeft={<Icon name="refresh-cw" size={13} />}
        onClick={onProbe}
        loading={probing || status === "running"}
        disabled={!canProbe}
      >
        Test connection
      </Button>
    </Card>
  );
}
