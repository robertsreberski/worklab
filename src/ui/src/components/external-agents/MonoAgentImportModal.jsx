import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import {
  acpEndpointUnsupported,
  monoSourceCompatibilityHint,
  monoSourceImportable,
  normalizeMonoDiscovery,
} from "../../lib/externalAgents.js";
import { Modal } from "../Modal.jsx";
import { Button } from "../primitives/Button.jsx";
import { StatusPill } from "../primitives/StatusPill.jsx";
import { Icon } from "../Icon.jsx";
import { Banner } from "../Banner.jsx";
import { LoadingState } from "../LoadingState.jsx";

function healthStatus(source) {
  if (source.ready || ["running", "ready", "healthy", "online", "alive"].includes(source.health)) return "complete";
  if (["starting", "probing", "pending"].includes(source.health)) return "running";
  if (["failed", "unhealthy", "offline", "stopped"].includes(source.health)) return "failed";
  return "disabled";
}

function importedAgentName(result, sourceId) {
  return result?.agent?.name
    || result?.profile?.agent?.name
    || result?.profile?.agentName
    || result?.profile?.agent_name
    || result?.agentName
    || sourceId;
}

export function MonoAgentImportModal({ open, onClose, onImported }) {
  const [discovery, setDiscovery] = useState({ schema: "", sources: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busySourceId, setBusySourceId] = useState(null);

  function load() {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setUnsupported(false);
    api.discoverMonoAgents({ signal: controller.signal })
      .then((response) => setDiscovery(normalizeMonoDiscovery(response)))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (acpEndpointUnsupported(err)) setUnsupported(true);
        else setError(err?.message || "mono-agent discovery failed");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }

  useEffect(() => {
    if (!open) return undefined;
    return load();
  }, [open]);

  async function importSource(source) {
    setBusySourceId(source.sourceId);
    setError(null);
    try {
      const result = await api.importMonoAgent(source.sourceId);
      onImported?.(importedAgentName(result, source.sourceId));
    } catch (err) {
      setError(err?.message || "Import failed");
    } finally {
      setBusySourceId(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import mono-agent"
      size="lg"
      class="mono-agent-import-modal"
      footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}
    >
      <p class="soft-meta">
        Worklab reads mono-agent's sanitized discovery contract. Secrets, URLs, and configuration content are never displayed or submitted.
      </p>
      {discovery.schema && <div class="mono-discovery-contract"><Icon name="check-circle" size={13} /> {discovery.schema}</div>}
      {loading && <LoadingState caption="Discovering mono-agent sources…" />}
      {unsupported && (
        <Banner
          variant="info"
          title="Discovery is not available"
          detail="This Worklab runtime does not expose mono-agent discovery yet. You can create a manual stdio ACP agent instead."
          actions={<Button size="sm" onClick={load}>Retry</Button>}
          dismissible={false}
        />
      )}
      {error && <Banner variant="error" title="Discovery failed" detail={error} actions={<Button size="sm" onClick={load}>Retry</Button>} dismissible={false} />}
      {!loading && !unsupported && !error && discovery.sources.length === 0 && (
        <div class="mono-discovery-empty">
          <Icon name="search" size={20} />
          <strong>No sources found</strong>
          <span>Start a discoverable mono-agent instance, then retry.</span>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      )}
      {discovery.sources.length > 0 && (
        <div class="mono-discovery-list" role="list">
          {discovery.sources.map((source) => (
            <div class="mono-discovery-source" role="listitem" key={source.sourceId}>
              <div class="mono-discovery-source-main">
                <div class="mono-discovery-source-head">
                  <strong>{source.label}</strong>
                  <StatusPill status={healthStatus(source)} label={source.health} size="sm" />
                </div>
                <span class="pane-row-mono">{source.sourceId}</span>
                {source.compatible !== true && (
                  <div class="mono-discovery-compatibility" role="status">
                    <Icon name="alert-triangle" size={14} />
                    <span>{monoSourceCompatibilityHint(source)}</span>
                  </div>
                )}
                {source.warnings.length > 0 && (
                  <div class="mono-discovery-warnings" aria-label="mono-agent compatibility warnings">
                    {source.warnings.map((warning, index) => <span key={`${warning}-${index}`}>{warning}</span>)}
                  </div>
                )}
                <div class="mono-discovery-capabilities">
                  {source.capabilities.sessions === true && <span>Sessions</span>}
                  {source.constraints.promptContent.includes("resource_link") && <span>Text + resource links</span>}
                  {source.constraints.attachments === false && <span>No attachments</span>}
                  {source.capabilities.filesystem === false && <span>No client filesystem</span>}
                  {source.capabilities.terminal === false && <span>No client terminal</span>}
                  {source.capabilities.clientMcp === false && <span>No client MCP</span>}
                </div>
              </div>
              <Button
                variant={source.imported ? "secondary" : "primary"}
                size="sm"
                disabled={source.imported || !monoSourceImportable(source)}
                loading={busySourceId === source.sourceId}
                onClick={() => importSource(source)}
              >
                {source.imported ? "Imported" : source.compatible !== true ? "Upgrade required" : "Import"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
