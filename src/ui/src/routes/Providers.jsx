import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { AppShell, MobilePillRow, MobileTopbar, useAppChrome } from "../components/AppShell.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { PathOrUrlInput, SecretInput } from "../components/primitives/index.js";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Banner } from "../components/Banner.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { Modal } from "../components/Modal.jsx";
import { Icon } from "../components/Icon.jsx";
import { DetailHead, PaneListHeader, SectionMarker } from "../components/layout/index.js";
import { pushToast } from "../lib/toast.js";
import { useFormSave } from "../lib/useFormSave.js";
import { navigateHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";

const PROVIDER_TYPE_OPTIONS = [
  { value: "ollama", label: "Ollama" },
  { value: "lmstudio", label: "LM Studio" },
  { value: "vllm", label: "vLLM" },
  { value: "openai_compat", label: "OpenAI-compatible" },
  { value: "groq", label: "Groq" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "together", label: "Together AI" },
  { value: "fireworks", label: "Fireworks AI" },
  { value: "deepseek", label: "DeepSeek" },
];

const PRESETS = {
  ollama: { name: "Ollama (local)", base_url: "http://localhost:11434", trust_public_url: false, api_key_hint: "No API key needed for most local setups." },
  lmstudio: { name: "LM Studio", base_url: "http://localhost:1234", trust_public_url: false, api_key_hint: "Usually no API key." },
  vllm: { name: "vLLM", base_url: "http://localhost:8000", trust_public_url: false, api_key_hint: "Often fronted by an internal gateway." },
  openai_compat: { name: "Custom gateway", base_url: "", trust_public_url: false, api_key_hint: "Any OpenAI-compatible host." },
  groq: { name: "Groq", base_url: "https://api.groq.com/openai", trust_public_url: true, api_key_hint: "API key required." },
  openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api", trust_public_url: true, api_key_hint: "API key required." },
  together: { name: "Together AI", base_url: "https://api.together.xyz", trust_public_url: true, api_key_hint: "API key required." },
  fireworks: { name: "Fireworks AI", base_url: "https://api.fireworks.ai/inference", trust_public_url: true, api_key_hint: "API key required." },
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com", trust_public_url: true, api_key_hint: "API key required." },
};

const EMPTY_FORM = {
  name: PRESETS.ollama.name,
  provider_type: "ollama",
  base_url: PRESETS.ollama.base_url,
  api_key: "",
  trust_public_url: PRESETS.ollama.trust_public_url,
  enabled: true,
};

const PROVIDER_EDIT_SECTIONS = [
  { id: "provider-edit-settings", num: "01", label: "Settings", meta: "Connection" },
  { id: "provider-edit-models", num: "02", label: "Models", meta: "Discovery" },
];

function EntityChromeBridge({ chrome }) {
  useAppChrome(chrome, [chrome]);
  return null;
}

function providerTypeLabel(value) {
  return PROVIDER_TYPE_OPTIONS.find((option) => option.value === value)?.label || value;
}

function providerIcon(value) {
  if (value === "ollama" || value === "lmstudio" || value === "vllm") return "database";
  if (value === "groq" || value === "fireworks" || value === "together") return "zap";
  return "terminal";
}

function applyPreset(form, providerType) {
  const previous = PRESETS[form.provider_type] || PRESETS.openai_compat;
  const next = PRESETS[providerType] || PRESETS.openai_compat;
  return {
    ...form,
    provider_type: providerType,
    name: !form.name || form.name === previous.name ? next.name : form.name,
    base_url: !form.base_url || form.base_url === previous.base_url ? next.base_url : form.base_url,
    trust_public_url: next.trust_public_url,
  };
}

function isEmbeddingOnlyModel(capabilities = {}) {
  return capabilities.embedding === true && capabilities.runnable_for_agent === false;
}

function modelCapabilityTags(model) {
  const capabilities = model.capabilities || {};
  if (isEmbeddingOnlyModel(capabilities)) return [{ label: "Embedding", variant: "accent" }];

  const tags = [];
  if (capabilities.runnable_for_agent !== false) tags.push({ label: "Chat", variant: "tag" });
  if (capabilities.tool_use) tags.push({ label: "Tools", variant: "tag" });
  if (capabilities.reasoning) tags.push({ label: capabilities.reasoning_mode === "toggle" ? "Thinking" : "Reasoning", variant: "tag" });
  if (capabilities.vision) tags.push({ label: "Vision", variant: "tag" });
  if (capabilities.embedding) tags.push({ label: "Embedding", variant: "accent" });
  if (!tags.length) tags.push({ label: "Unsupported", variant: "ghost" });
  return tags;
}

function modelPurpose(model) {
  const capabilities = model.capabilities || {};
  if (isEmbeddingOnlyModel(capabilities)) {
    return model.enabled
      ? "Used for knowledge search. Not a chat model."
      : "Enable to show in Settings -> Embeddings.";
  }
  if (capabilities.embedding === true) {
    return model.enabled
      ? "Available for agents and embeddings."
      : "Enable for agents or embeddings.";
  }
  if (capabilities.runnable_for_agent !== false) {
    return model.enabled ? "Available for agent model pickers." : "Enable for agents.";
  }
  return "Not usable for agents or embeddings.";
}

function modelSwitchLabel(model) {
  return model.enabled ? "Enabled" : "Disabled";
}

function ProviderEdit({ providerId, onSaved, onDeleted }) {
  const isNew = providerId === "new";
  const [provider, setProvider] = useState(isNew ? EMPTY_FORM : null);
  const [baseline, setBaseline] = useState(isNew ? EMPTY_FORM : null);
  const [models, setModels] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState(null);
  const [discoveryStatus, setDiscoveryStatus] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const loadModels = useCallback(async (id) => {
    const response = await api.listProviderModels(id);
    setModels(response.models || []);
  }, []);

  const testProviderConnection = useCallback(async (id = providerId, { isCancelled = () => false } = {}) => {
    if (isNew) return null;
    setConnectionStatus({ kind: "testing" });
    try {
      const result = await api.testProvider(id);
      if (!isCancelled()) setConnectionStatus({ kind: "test", result });
      return result;
    } catch (error) {
      if (!isCancelled()) setConnectionStatus({ kind: "error", message: error.message });
      return null;
    }
  }, [isNew, providerId]);

  const discoverProviderModels = useCallback(async (id = providerId, { isCancelled = () => false } = {}) => {
    if (isNew) return null;
    setDiscoveryStatus({ kind: "discovering" });
    try {
      const result = await api.discoverProviderModels(id);
      if (!isCancelled()) {
        setModels(result.models || []);
        setDiscoveryStatus({ kind: "discovered", count: (result.models || []).length });
      }
      return result;
    } catch (error) {
      if (!isCancelled()) setDiscoveryStatus({ kind: "error", message: error.message });
      return null;
    }
  }, [isNew, providerId]);

  useEffect(() => {
    let cancelled = false;
    setConnectionStatus(null);
    setDiscoveryStatus(null);
    if (isNew) {
      setProvider(EMPTY_FORM);
      setBaseline(EMPTY_FORM);
      setModels([]);
      return () => { cancelled = true; };
    }
    setProvider(null);
    api.getProvider(providerId)
      .then((response) => {
        if (cancelled) return;
        const next = { ...response.provider, api_key: "" };
        setProvider(next);
        setBaseline(next);
      })
      .catch(() => { if (!cancelled) setProvider({ notFound: true }); });
    loadModels(providerId).catch(() => { if (!cancelled) setModels([]); });
    testProviderConnection(providerId, { isCancelled: () => cancelled });
    discoverProviderModels(providerId, { isCancelled: () => cancelled });
    return () => { cancelled = true; };
  }, [discoverProviderModels, isNew, loadModels, providerId, testProviderConnection]);

  const isDirty = useMemo(
    () => (baseline ? JSON.stringify(provider) !== JSON.stringify(baseline) : true),
    [baseline, provider],
  );

  const formSave = useFormSave(async () => {
    const payload = {
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url,
      api_key: provider.api_key || undefined,
      trust_public_url: !!provider.trust_public_url,
      enabled: !!provider.enabled,
    };
    if (isNew) {
      const response = await api.createProvider(payload);
      pushToast("Provider created", { variant: "success" });
      onSaved?.(response.provider.id);
      return response.provider.id;
    }
    const response = await api.patchProvider(providerId, payload);
    pushToast("Saved.", { variant: "success" });
    const next = { ...response.provider, api_key: "" };
    setProvider(next);
    setBaseline(next);
    onSaved?.(providerId);
    return providerId;
  });

  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });
  const cancel = () => guard.requestNavigation("#/providers");

  useGlobalShortcuts({
    cmds: (event) => {
      event.preventDefault();
      formSave.save().catch(() => {});
    },
    Escape: () => cancel(),
  });

  if (!provider) return <LoadingState caption="Loading provider…" />;
  if (provider.notFound) {
    return (
      <div class="pane-empty">
        <h3>Provider not found</h3>
        <p>This provider may have been deleted.</p>
      </div>
    );
  }

  const preset = PRESETS[provider.provider_type] || PRESETS.openai_compat;
  const saveButtonVariant = isDirty || isNew ? "primary" : "secondary";
  const saveButtonLabel = isNew ? "Create" : "Save";
  const saveDisabled = !provider.name || !provider.base_url;
  const headerActions = (
    <>
      {!isNew && <StatusPill status={provider.enabled ? "enabled" : "disabled"} />}
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      {!isNew && (
        <Button
          variant="secondary"
          loading={connectionStatus?.kind === "testing"}
          onClick={() => testProviderConnection()}
          disabled={isDirty}
          title={isDirty ? "Save provider changes before testing." : undefined}
        >
          Test
        </Button>
      )}
      {!isNew && (
        <Button
          variant="secondary"
          loading={discoveryStatus?.kind === "discovering"}
          onClick={() => discoverProviderModels()}
          disabled={isDirty}
          title={isDirty ? "Save provider changes before discovering models." : undefined}
        >
          Discover
        </Button>
      )}
      <Button
        variant={saveButtonVariant}
        loading={formSave.saving}
        onClick={() => formSave.save().catch(() => {})}
        disabled={saveDisabled}
      >
        {saveButtonLabel}
      </Button>
    </>
  );
  const mobileActionDock = (
    <>
      <Button variant="secondary" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        loading={formSave.saving}
        onClick={() => formSave.save().catch(() => {})}
        disabled={saveDisabled}
      >
        {saveButtonLabel}
      </Button>
    </>
  );

  function renderProviderRail() {
    return (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="Connection" class="entity-rail-card">
          <div class="task-context-list">
            <div class="task-context-row">
              <span class="task-context-icon"><Icon name={providerIcon(provider.provider_type)} size={13} /></span>
              <span class="task-context-copy">
                <span class="task-context-label">Type</span>
                <span class="task-context-value">{providerTypeLabel(provider.provider_type)}</span>
              </span>
            </div>
            <div class="task-context-row">
              <span class="task-context-icon"><Icon name="terminal" size={13} /></span>
              <span class="task-context-copy">
                <span class="task-context-label">Models</span>
                <span class="task-context-value">{models.length}</span>
              </span>
            </div>
          </div>
        </Card>

        {!isNew && (
          <Card variant="spacious" title="Provider actions" class="entity-rail-card">
            <div class="task-actions-stack">
              <Button
                variant="secondary"
                loading={connectionStatus?.kind === "testing"}
                onClick={() => testProviderConnection()}
                disabled={isDirty}
                title={isDirty ? "Save provider changes before testing." : undefined}
              >
                Test connection
              </Button>
              <Button
                variant="secondary"
                loading={discoveryStatus?.kind === "discovering"}
                onClick={() => discoverProviderModels()}
                disabled={isDirty}
                title={isDirty ? "Save provider changes before discovering models." : undefined}
              >
                Discover models
              </Button>
            </div>
          </Card>
        )}

        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }} class="entity-rail-card">
            <Button
              variant="destructive"
              iconLeft={<Icon name="trash" size={13} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete provider
            </Button>
          </Card>
        )}
      </div>
    );
  }

  async function removeProvider() {
    try {
      await api.deleteProvider(providerId);
      pushToast("Provider deleted", { variant: "success" });
      onDeleted?.();
    } catch (error) {
      pushToast(`Delete failed: ${error.message}`, { variant: "error" });
    }
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={isNew ? "New provider" : provider.name} backLabel="Providers" onBack={cancel} />,
          mobileActionDock,
          drawerTitle: "Details",
          drawerKicker: provider.provider_type || "provider",
          drawerContent: renderProviderRail(),
          sections: PROVIDER_EDIT_SECTIONS,
        }}
      />
      <DetailHead
        icon={<Icon name="terminal" size={16} />}
        kicker={isNew ? "Create provider" : "Provider"}
        title={isNew ? "New provider" : provider.name}
        meta={(
          <>
            <span class="pane-row-mono">{provider.provider_type || "provider"}</span>
            {provider.base_url && (
              <>
                <span class="pane-row-dot">·</span>
                <span>{provider.base_url}</span>
              </>
            )}
          </>
        )}
        actions={headerActions}
        subBar={<MobilePillRow railLabel="Details" railCount={isNew ? 1 : 3} sections={PROVIDER_EDIT_SECTIONS} />}
      />

      <div class="pane-detail-body entity-detail-body provider-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}
        {connectionStatus?.kind === "testing" && (
          <Banner variant="info" title="Checking provider" detail="Testing the saved provider connection." dismissible={false} />
        )}
        {connectionStatus?.kind === "test" && (
          <Banner
            variant={connectionStatus.result.ok ? "success" : "error"}
            title={connectionStatus.result.ok ? "Provider reachable" : "Provider unreachable"}
            detail={connectionStatus.result.ok ? `HTTP ${connectionStatus.result.status} in ${connectionStatus.result.duration_ms ?? 0}ms.` : (connectionStatus.result.error || "Connection failed.")}
          />
        )}
        {connectionStatus?.kind === "error" && (
          <Banner variant="error" title="Provider check failed" detail={connectionStatus.message} />
        )}
        {discoveryStatus?.kind === "discovering" && (
          <Banner variant="info" title="Discovering models" detail="Refreshing models from the saved provider connection." dismissible={false} />
        )}
        {discoveryStatus?.kind === "discovered" && (
          <Banner
            variant="success"
            title="Discovery complete"
            detail={`Found ${discoveryStatus.count} model${discoveryStatus.count === 1 ? "" : "s"}. Embedding models are enabled automatically for Settings.`}
          />
        )}
        {discoveryStatus?.kind === "error" && (
          <Banner variant="error" title="Discovery failed" detail={discoveryStatus.message} />
        )}

        <div class="entity-editor-layout provider-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="provider-edit-settings" num="01" kicker="Settings" meta="Connection" />
            <FormSection kicker="Identity" title="Provider settings">
              <FormField label="Type">
                <div class="provider-type-select">
                  <Select
                    variant="native"
                    value={provider.provider_type}
                    onChange={(value) => setProvider((current) => applyPreset(current, value))}
                    options={PROVIDER_TYPE_OPTIONS}
                    ariaLabel="Provider type"
                  />
                </div>
              </FormField>
              <FormGrid columns={2}>
                <FormField label="Name" required>
                  <Input value={provider.name} onInput={(event) => setProvider({ ...provider, name: event.target.value })} />
                </FormField>
                <FormField label="Base URL" required>
                  <PathOrUrlInput kind="url" value={provider.base_url} onInput={(event) => setProvider({ ...provider, base_url: event.target.value })} placeholder={preset.base_url || "https://..."} />
                </FormField>
                <FormField label="API key" hint={preset.api_key_hint} class="span-2">
                  <SecretInput autocomplete="new-password" value={provider.api_key || ""} onInput={(event) => setProvider({ ...provider, api_key: event.target.value })} />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={!!provider.trust_public_url}
                    onChange={(value) => setProvider({ ...provider, trust_public_url: value })}
                    label="Trust public HTTPS URL"
                    description="Required for hosted providers that enforce HTTPS."
                  />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={!!provider.enabled}
                    onChange={(value) => setProvider({ ...provider, enabled: value })}
                    label="Show in model pickers"
                    description="Disable to hide all this provider's models without removing them."
                  />
                </FormField>
              </FormGrid>
            </FormSection>

            {!isNew && (
              <>
                <SectionMarker id="provider-edit-models" num="02" kicker="Models" meta="Discovery" />
                <FormSection kicker="Models" title="Discovered models" description="Opening a provider tests the connection and refreshes this list automatically. Use the visible Test and Discover buttons to retry.">
                  {(models || []).length === 0 ? (
                    <div class="field-hint">No models yet. Discovery runs automatically when the provider opens; use Discover above to retry.</div>
                  ) : (
                    <div class="provider-model-grid">
                      {models.map((model) => {
                        const capabilities = model.capabilities || {};
                        const embeddingOnly = isEmbeddingOnlyModel(capabilities);
                        return (
                          <div key={model.id} class={`card card-inset provider-model-card ${embeddingOnly ? "is-embedding" : ""}`.trim()}>
                            <div class="provider-model-row">
                              <div class="provider-model-info">
                                <strong class="provider-model-name">{model.display_name || model.model_name}</strong>
                                <div class="mono muted provider-model-id">{model.model_name}</div>
                                <div class="provider-model-caps">
                                  {modelCapabilityTags(model).map((tag) => (
                                    <Chip key={tag.label} variant={tag.variant}>{tag.label}</Chip>
                                  ))}
                                </div>
                                <div class="provider-model-purpose">{modelPurpose(model)}</div>
                              </div>
                              <Switch
                                checked={!!model.enabled}
                                onChange={() => {
                                  api.patchProviderModel(providerId, model.id, { enabled: !model.enabled })
                                    .then(() => loadModels(providerId))
                                    .catch((error) => pushToast(`Model update failed: ${error.message}`, { variant: "error" }));
                                }}
                                label={modelSwitchLabel(model)}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </FormSection>
              </>
            )}
          </main>

          <aside class="entity-editor-rail is-mobile-drawer-source">
            {renderProviderRail()}
          </aside>
        </div>
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete "${provider.name}"?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); removeProvider(); }}>Delete</Button>
          </>
        }
      >
        <p>This removes the provider and its discovered models.</p>
      </Modal>

      <Modal
        open={guard.promptOpen}
        onClose={guard.keepEditing}
        title="You have unsaved changes"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={guard.keepEditing}>Keep editing</Button>
            <Button variant="destructive" onClick={guard.discardAndLeave}>Discard</Button>
            <Button variant="primary" loading={formSave.saving} onClick={() => guard.saveAndLeave().catch(() => {})}>
              Save & leave
            </Button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    </>
  );
}

export function Providers({ selectedId = null }) {
  const [providers, setProviders] = useState([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    api.listProviders({ signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setProviders(response.providers || []); })
      .catch((err) => { if (err?.name !== "AbortError") setProviders([]); });
  }, []);
  const reloadSoon = useThrottledCallback(reload, 100);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);
  useSSE("global", (event) => {
    if (event.type?.startsWith("provider_")) reloadSoon();
  });
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return providers;
    return providers.filter((provider) => (
      provider.name?.toLowerCase().includes(normalized) ||
      provider.base_url?.toLowerCase().includes(normalized) ||
      provider.provider_type?.toLowerCase().includes(normalized)
    ));
  }, [providers, query]);

  const listHeader = (
    <PaneListHeader
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search providers…"
      searchAriaLabel="Search providers"
      searchRef={searchRef}
      actionLabel="New provider"
      onAction={() => navigateHash("#/providers/new")}
    />
  );

  const listBody = filtered.length === 0 ? (
    query ? (
      <EmptyStateFiltered body="No providers match." onClearFilters={() => setQuery("")} />
    ) : (
      <EmptyState
        title="No providers yet"
        body="Add a provider to use local or hosted models."
        cta={<Button variant="primary" onClick={() => navigateHash("#/providers/new")}>New provider</Button>}
      />
    )
  ) : (
    filtered.map((provider) => (
      <PaneRow
        key={provider.id}
        href={`#/providers/${provider.id}`}
        active={provider.id === selectedId}
        onClick={(event) => {
          event?.preventDefault?.();
          navigateHash(`#/providers/${provider.id}`);
        }}
        leading={<Icon name={providerIcon(provider.provider_type)} size={16} />}
        title={provider.name}
        sub={providerTypeLabel(provider.provider_type)}
        trailing={(
          <span class="pane-row-summary">
            <StatusPill status={provider.enabled ? "enabled" : "disabled"} size="sm" />
            <span>{provider.model_count || 0} models</span>
          </span>
        )}
      />
    ))
  );

  const detail = selectedId ? (
    <ProviderEdit
      key={selectedId}
      providerId={selectedId}
      onSaved={(id) => {
        reload();
        if (selectedId === "new" && id) navigateHash(`#/providers/${id}`);
      }}
      onDeleted={() => {
        reload();
        navigateHash("#/providers");
      }}
    />
  ) : (
    <div class="pane-empty">
      <Icon name="terminal" size={28} />
      <h3>Select a provider</h3>
      <p>Choose a provider from the list to edit it, or create a new one.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => navigateHash("#/providers/new")}>
        New provider
      </Button>
    </div>
  );

  return (
    <AppShell route="providers">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedId}
        detailOwnsMobileBack={!!selectedId}
        onBack={() => navigateHash("#/providers")}
        backLabel="All providers"
      />
    </AppShell>
  );
}
