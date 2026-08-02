import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import {
  acpEndpointUnsupported,
  acpProfileForAgent,
  externalAgentDraft,
  externalEnvKeysValid,
  externalAgentMutationPayload,
  normalizeAcpProfile,
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

function emptyDraft() {
  return externalAgentDraft({ profile: { driver: "generic" } });
}

function profileBody(result) {
  return result?.profile || result || null;
}

function operationBody(result) {
  return result?.operation || result || null;
}

function operationId(operation) {
  return operation?.id || operation?.operationId || operation?.operation_id || null;
}

function operationFinished(operation) {
  const status = String(operation?.status || operation?.state || "").toLowerCase();
  return ["success", "succeeded", "complete", "completed", "failed", "error", "cancelled", "canceled"].includes(status);
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
  const [probeOperation, setProbeOperation] = useState(null);
  const [probing, setProbing] = useState(false);
  const pollTimerRef = useRef(null);

  const update = useCallback((patch) => setDraft((current) => ({ ...current, ...patch })), []);

  const load = useCallback(async ({ preserveDraft = false } = {}) => {
    if (isNew) {
      const next = emptyDraft();
      setDraft(next);
      setBaseline(next);
      setProfile(null);
      setAgentResource(null);
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

  async function refreshVolatileProfile() {
    if (!profile?.id) return;
    try {
      const result = await api.getAcpProfile(profile.id);
      setProfile(profileBody(result));
    } catch {
      // A failed refresh must not replace an otherwise usable saved profile.
    }
  }

  function pollOperation(id) {
    if (!id) return;
    pollTimerRef.current = setTimeout(async () => {
      try {
        const result = await api.getAcpOperation(id);
        const operation = operationBody(result);
        setProbeOperation(operation);
        if (operationFinished(operation)) {
          setProbing(false);
          await refreshVolatileProfile();
        } else {
          pollOperation(id);
        }
      } catch (err) {
        setProbing(false);
        pushToast(`Probe status failed: ${err.message}`, { variant: "error" });
      }
    }, 800);
  }

  async function probe() {
    if (!profile?.id) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setProbing(true);
    try {
      const result = await api.probeAcpProfile(profile.id);
      const operation = operationBody(result);
      setProbeOperation(operation);
      const id = operationId(operation);
      if (id && !operationFinished(operation)) pollOperation(id);
      else {
        setProbing(false);
        await refreshVolatileProfile();
      }
    } catch (err) {
      setProbing(false);
      pushToast(`Connection test failed: ${err.message}`, { variant: "error" });
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
  const isMono = normalizedProfile.driver === "mono";
  const agentManaged = draft.configurationOwner === "agent";
  const commandValid = agentManaged || draft.command.trim().startsWith("/");
  const cwdValid = agentManaged || !draft.cwd.trim() || draft.cwd.trim().startsWith("/");
  const workspaceManaged = draft.workspaceOwner === "agent";
  const workspaceValid = workspaceManaged || !draft.canonicalWorkspace.trim() || draft.canonicalWorkspace.trim().startsWith("/");
  const envKeysValid = agentManaged || externalEnvKeysValid(draft.envKeysText);
  const probeTimeoutValid = Number(draft.probeTimeoutMs) >= 1000 && Number(draft.probeTimeoutMs) <= 300000;
  const title = isNew ? "New external agent" : (draft.displayName || draft.agentName || name);
  const canSave = !!draft.displayName.trim() && commandValid && cwdValid && workspaceValid && envKeysValid && probeTimeoutValid && !unsupported;
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
        <AcpHealthCard profile={profile} operation={probeOperation} probing={probing} onProbe={probe} canProbe={!isNew && !!profile?.id} />
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
        subBar={<MobilePillRow railLabel="Status" railCount={3} sections={EXTERNAL_AGENT_SECTIONS} />}
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
                <FormField label="Display name" required>
                  <Input aria-label="Display name" value={draft.displayName} onInput={(event) => update({ displayName: event.currentTarget.value })} />
                </FormField>
                <FormField label="Description">
                  <Input aria-label="Description" value={draft.description} onInput={(event) => update({ description: event.currentTarget.value })} />
                </FormField>
                <FormField switchInside class="agent-availability-field">
                  <Switch checked={draft.enabled} onChange={(enabled) => update({ enabled })} label="Available for assignment" description="Disabled agents remain configured but cannot be assigned." />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="external-agent-launch" num="02" kicker="Launch" meta="stdio" />
            <FormSection kicker="Launch" title="ACP process" description="Worklab starts the executable directly and keeps stdout reserved for ACP JSON-RPC messages.">
              {agentManaged ? (
                <Banner
                  variant="info"
                  title="Launch configuration is agent-owned"
                  detail="Command, arguments, environment keys, and launch directory are managed by the external agent and intentionally hidden here."
                  dismissible={false}
                />
              ) : (
                <>
                  <FormField label="Command path" required error={commandValid ? null : "Use an absolute executable path."}>
                    <Input aria-label="Command path" value={draft.command} placeholder="/usr/local/bin/acp-agent" invalid={!commandValid} onInput={(event) => update({ command: event.currentTarget.value })} />
                  </FormField>
                  <FormGrid columns={2}>
                    <FormField label="Arguments" hint="One argument per line. Worklab never invokes a shell.">
                      <Textarea aria-label="Arguments" rows={6} monospace value={draft.argsText} onInput={(event) => update({ argsText: event.currentTarget.value })} />
                    </FormField>
                    <FormField label="Environment key names" hint="Names only, one per line. Values come from Worklab's process environment and are never shown here." error={envKeysValid ? null : "Use environment key names only; values and '=' are not accepted."}>
                      <Textarea aria-label="Environment key names" rows={6} monospace value={draft.envKeysText} placeholder="AGENT_TOKEN\nPATH" aria-invalid={!envKeysValid} onInput={(event) => update({ envKeysText: event.currentTarget.value })} />
                    </FormField>
                  </FormGrid>
                  <FormField label="Launch directory" hint="Optional absolute cwd used when starting the process." error={cwdValid ? null : "Use an absolute directory path."}>
                    <Input aria-label="Launch directory" value={draft.cwd} placeholder="/workspace" invalid={!cwdValid} onInput={(event) => update({ cwd: event.currentTarget.value })} />
                  </FormField>
                </>
              )}
            </FormSection>

            <SectionMarker id="external-agent-ownership" num="03" kicker="Ownership" meta="Boundaries" />
            <FormSection kicker="Ownership" title="Control boundaries" description="Each boundary has exactly one authority. Agent-owned controls are not duplicated in Worklab.">
              <FormGrid columns={3}>
                <FormField label="Configuration">
                  <Select ariaLabel="Configuration owner" variant="native" value={draft.configurationOwner} options={OWNER_OPTIONS} disabled={isMono} onChange={(configurationOwner) => update({ configurationOwner })} />
                </FormField>
                <FormField label="Workspace">
                  <Select ariaLabel="Workspace owner" variant="native" value={draft.workspaceOwner} options={OWNER_OPTIONS} disabled={isMono} onChange={(workspaceOwner) => update({ workspaceOwner })} />
                </FormField>
                <FormField label="MCP servers">
                  <Select ariaLabel="MCP owner" variant="native" value={draft.mcpOwner} options={OWNER_OPTIONS} disabled={isMono} onChange={(mcpOwner) => update({ mcpOwner })} />
                </FormField>
              </FormGrid>
              {workspaceManaged ? (
                <Banner variant="info" title="Workspace is agent-owned" detail="The canonical workspace is supplied by the external agent and is intentionally read-only in Worklab." dismissible={false} />
              ) : (
                <FormField label="Canonical workspace" hint="Optional absolute root used to validate task workspaces and ACP session cwd." error={workspaceValid ? null : "Use an absolute directory path."}>
                  <Input aria-label="Canonical workspace" value={draft.canonicalWorkspace} placeholder="/workspace" invalid={!workspaceValid} onInput={(event) => update({ canonicalWorkspace: event.currentTarget.value })} />
                </FormField>
              )}
            </FormSection>

            <SectionMarker id="external-agent-policy" num="04" kicker="Permissions" meta="Client policy" />
            <FormSection kicker="Permissions" title="ACP client access" description="All permissions are denied by default. Enable only the client services this external agent should be able to request.">
              {agentManaged ? (
                <Banner variant="info" title="Permissions are agent-owned" detail="ACP permissions and session policy come from the external agent's sanitized descriptor and are intentionally hidden here." dismissible={false} />
              ) : (
                <>
                  <FormGrid columns={2}>
                    <FormField switchInside><Switch checked={draft.allowFilesystem} onChange={(allowFilesystem) => update({ allowFilesystem })} label="Filesystem requests" description="Allow scoped Worklab client file reads and writes when implemented." /></FormField>
                    <FormField switchInside><Switch checked={draft.allowTerminal} onChange={(allowTerminal) => update({ allowTerminal })} label="Terminal requests" description="Allow scoped client terminal lifecycle requests when implemented." /></FormField>
                    <FormField switchInside><Switch checked={draft.allowNetwork} onChange={(allowNetwork) => update({ allowNetwork })} label="Network requests" description="Allow external network-facing client operations." /></FormField>
                    <FormField switchInside><Switch checked={draft.allowMcp} onChange={(allowMcp) => update({ allowMcp })} label="Client MCP servers" description="Allow Worklab to supply client-side MCP servers to this profile." /></FormField>
                  </FormGrid>
                  <FormGrid columns={2}>
                  <FormField label="Configuration policy (JSON)" hint="Advanced safe constraints only; secret-bearing fields are rejected by the server.">
                    <Textarea aria-label="Configuration policy" rows={6} monospace value={draft.configPolicyText} onInput={(event) => update({ configPolicyText: event.currentTarget.value })} />
                  </FormField>
                    <FormField label="Session policy (JSON)" hint="Advanced session lifecycle constraints.">
                      <Textarea aria-label="Session policy" rows={6} monospace value={draft.sessionPolicyText} onInput={(event) => update({ sessionPolicyText: event.currentTarget.value })} />
                    </FormField>
                  </FormGrid>
                  <FormField label="Probe timeout (ms)" hint="1,000–300,000 ms. Default 30,000." error={probeTimeoutValid ? null : "Enter a timeout from 1,000 to 300,000 ms."}>
                    <Input aria-label="Probe timeout" type="number" min={1000} max={300000} value={String(draft.probeTimeoutMs)} invalid={!probeTimeoutValid} onInput={(event) => update({ probeTimeoutMs: Number(event.currentTarget.value) || 0 })} />
                  </FormField>
                </>
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
