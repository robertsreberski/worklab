// §6.10 Settings — FormSections stacked. Switches use the new primitive (fixed alignment).
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { AppShell } from "../components/AppShell.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";

export function Settings() {
  const [settings, setSettings] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null);
  const [embeddingGroups, setEmbeddingGroups] = useState([]);

  useEffect(() => {
    api.getSettings().then((r) => { setSettings(r.settings); setBaseline(r.settings); });
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
    api.listEmbeddingModels().then((r) => setEmbeddingGroups(r.groups || [])).catch(() => setEmbeddingGroups([]));
  }, []);

  const isDirty = useMemo(() => baseline ? JSON.stringify(settings) !== JSON.stringify(baseline) : false, [settings, baseline]);

  const formSave = useFormSave(async () => {
    await api.patchSettings({
      consolidation_hour: Number(settings.consolidation_hour),
      consolidation_enabled: !!settings.consolidation_enabled,
      worker_timeout_ms: Number(settings.worker_timeout_ms),
      cancel_grace_ms: Number(settings.cancel_grace_ms),
      journal_tail_lines: Number(settings.journal_tail_lines),
      kb_pinned_limit: Number(settings.kb_pinned_limit),
      default_embedding_model: settings.default_embedding_model,
    });
    pushToast("Saved.", { variant: "success" });
    setBaseline(settings);
  });

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
  });

  if (!settings) {
    return (
      <AppShell route="settings" title="Settings">
        <div class="page-wrap"><LoadingState caption="Loading settings…" /></div>
      </AppShell>
    );
  }

  const currentEmbedding = settings.default_embedding_model || "";
  const allEmbeddingValues = embeddingGroups.flatMap((g) => (g.models || []).map((m) => m.value));
  const embeddingOptions = [
    { label: "", options: [{ value: "", label: "(disabled — no embeddings)" }] },
    ...(currentEmbedding && !allEmbeddingValues.includes(currentEmbedding)
      ? [{ label: "Current", options: [{ value: currentEmbedding, label: `${currentEmbedding} (custom)` }] }]
      : []),
    ...embeddingGroups.map((g) => ({
      label: g.available === false ? `${g.label} (credentials not set)` : g.label,
      options: (g.models || []).map((m) => ({
        value: m.value,
        label: m.label || m.value,
        description: g.available === false ? (g.unavailable_reason || "Unavailable") : (m.description || undefined),
        disabled: g.available === false || m.available === false || m.disabled === true,
      })),
    })),
  ];

  const headerActions = (
    <Button
      variant={isDirty ? "primary" : "secondary"}
      loading={formSave.saving}
      onClick={() => formSave.save().catch(() => {})}
    >
      Save
    </Button>
  );

  return (
    <AppShell route="settings" title="Settings" headerActions={headerActions}>
      <div class="page-wrap">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}

        <div class="settings-sections">
          <FormSection kicker="Memory" title="Consolidation" description="Nightly memory consolidation refreshes agent journal summaries.">
            <FormGrid columns={2}>
              <FormField label="Hour (0–23)">
                <Input type="number" min="0" max="23" value={settings.consolidation_hour} onInput={(e) => setSettings({ ...settings, consolidation_hour: e.target.value })} />
              </FormField>
              <FormField switchInside>
                <Switch
                  checked={!!settings.consolidation_enabled}
                  onChange={(next) => setSettings({ ...settings, consolidation_enabled: next })}
                  label="Enabled"
                  description="Run the scheduled consolidation job each night."
                />
              </FormField>
              <FormField label="Journal tail lines">
                <Input type="number" min="0" max="1000" value={settings.journal_tail_lines} onInput={(e) => setSettings({ ...settings, journal_tail_lines: e.target.value })} />
              </FormField>
              <FormField label="Pinned KB limit">
                <Input type="number" min="0" max="100" value={settings.kb_pinned_limit} onInput={(e) => setSettings({ ...settings, kb_pinned_limit: e.target.value })} />
              </FormField>
            </FormGrid>
          </FormSection>

          <FormSection kicker="Runtime" title="Execution" description="Limits for worker subprocesses.">
            <FormGrid columns={2}>
              <FormField label="Worker timeout (ms)">
                <Input type="number" value={settings.worker_timeout_ms} onInput={(e) => setSettings({ ...settings, worker_timeout_ms: e.target.value })} />
              </FormField>
              <FormField label="Cancel grace (ms)">
                <Input type="number" value={settings.cancel_grace_ms} onInput={(e) => setSettings({ ...settings, cancel_grace_ms: e.target.value })} />
              </FormField>
            </FormGrid>
          </FormSection>

          <FormSection kicker="Search" title="Embeddings" description="Controls which embedding model is used to index knowledge and journals.">
            <FormField
              label="Embedding model"
              hint='Disabled skips vectorization. Run "Discover" on a provider to surface more models.'
            >
              <Select
                value={currentEmbedding}
                options={embeddingOptions}
                onChange={(value) => setSettings({ ...settings, default_embedding_model: value })}
              />
            </FormField>
            {indexStatus && (
              <div class={`settings-index-status ${indexStatus.errors ? "has-errors" : ""}`}>
                Search index: {indexStatus.total} chunks · {indexStatus.vectorized} vectorized · {indexStatus.errors} errors · {indexStatus.model || "—"}
                {indexStatus.model && !indexStatus.ready && ` · paused (${indexStatus.reason || "provider not configured"})`}
              </div>
            )}
          </FormSection>
        </div>
      </div>
    </AppShell>
  );
}
