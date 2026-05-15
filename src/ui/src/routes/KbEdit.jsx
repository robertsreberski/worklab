// §6.7 KbEdit — metadata · body · references.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { ProjectPicker } from "../components/ProjectPicker.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { MentionableTextarea } from "../components/MentionableTextarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { TagInput } from "../components/primitives/SpecialInputs.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { EntityChromeBridge } from "../components/EntityChromeBridge.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { EntityBadge } from "../components/EntityBadge.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { Icon } from "../components/Icon.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { EMPTY_KB_FORM_ENTRY, kbFormEntryFromQuery, normalizeKbFormEntry } from "./kb-entry-form.js";
import { proceedToHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { taskRouteId } from "../lib/display.js";
import { agentLabel } from "../lib/agentLinks.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { EntityEditorModals } from "./EntityEditorModals.jsx";

const KB_EDIT_SECTIONS = [
  { id: "kb-edit-details", num: "01", label: "Details", meta: "Metadata" },
  { id: "kb-edit-body", num: "02", label: "Body", meta: "Markdown" },
  { id: "kb-edit-references", num: "03", label: "References", meta: "Usage" },
];

const CATEGORY_OPTIONS = [
  { value: "", label: "Uncategorized" },
  { value: "run-results", label: "Run results" },
  { value: "research", label: "Research" },
  { value: "decision", label: "Decision" },
  { value: "qa", label: "QA" },
  { value: "runbook", label: "Runbook" },
  { value: "operations", label: "Operations" },
  { value: "reference", label: "Reference" },
  { value: "howto", label: "How-to" },
  { value: "policy", label: "Policy" },
];

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

export function KbEdit({ slug, onSaved, onDeleted, prefill = null, tagSuggestions = [] }) {
  const isNew = slug === "new";
  const newEntry = useMemo(() => isNew ? kbFormEntryFromQuery(prefill || {}) : EMPTY_KB_FORM_ENTRY, [isNew, prefill]);
  const [entry, setEntry] = useState(isNew ? newEntry : null);
  const [baseline, setBaseline] = useState(isNew ? newEntry : null);
  const [projects, setProjects] = useState([]);
  const [usage, setUsage] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    if (isNew) {
      setEntry(newEntry);
      setBaseline(newEntry);
      return () => { cancelled = true; };
    }
    setEntry(null);
    api.getKb(slug)
      .then((r) => { if (!cancelled) { const n = normalizeKbFormEntry(r.entry); setEntry(n); setBaseline(n); } })
      .catch(() => { if (!cancelled) setEntry({ notFound: true }); });
    api.kbUsage(slug).then((r) => { if (!cancelled) setUsage(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [slug, isNew, newEntry]);

  useEffect(() => {
    let cancelled = false;
    api.listProjects({ include_archived: "true" })
      .then((res) => { if (!cancelled) setProjects(res.projects || []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  const formSave = useFormSave(async ({ navigateOnSuccess = true } = {}) => {
    if (!entry.title.trim()) throw new Error("Title is required.");
    const payload = {
      title: entry.title.trim(),
      body: entry.body,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      category: entry.category.trim() || null,
      subcategory: entry.subcategory.trim() || null,
      project_id: entry.project_id || null,
      source_task_id: entry.source_task_id.trim() || null,
      source_task_key: entry.source_task_key.trim() || null,
      source_run_id: entry.source_run_id.trim() || null,
      source_agent: entry.source_agent.trim() || null,
      related_slugs: cleanList(entry.related_slugs),
      supersedes_slugs: cleanList(entry.supersedes_slugs),
      canonical_slug: entry.canonical_slug.trim() || null,
      pinned: !!entry.pinned,
    };
    if (isNew) {
      const res = await api.createKb(payload);
      const savedSlug = res.entry?.meta?.slug || res.entry?.slug;
      pushToast("Entry created", { variant: "success" });
      setBaseline(entry);
      onSaved?.(savedSlug);
      if (navigateOnSuccess && savedSlug) proceedToHash(`#/library/knowledge/${savedSlug}`);
    } else {
      await api.patchKb(slug, payload);
      pushToast("Saved.", { variant: "success" });
      setBaseline(entry);
      onSaved?.(slug);
      if (navigateOnSuccess) proceedToHash(`#/library/knowledge/${slug}`);
    }
  });
  const isDirty = useMemo(() => baseline ? JSON.stringify(entry) !== JSON.stringify(baseline) : true, [entry, baseline]);
  useAppResume(() => {
    if (isNew) return;
    if (!isDirty) {
      api.getKb(slug)
        .then((r) => {
          const next = normalizeKbFormEntry(r.entry);
          setEntry(next);
          setBaseline(next);
        })
        .catch(() => setEntry({ notFound: true }));
    }
    api.kbUsage(slug).then((r) => setUsage(r)).catch(() => {});
  });
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save({ navigateOnSuccess: false }) });
  const cancel = () => guard.requestNavigation(isNew ? "#/library/knowledge" : `#/library/knowledge/${slug}`);

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
    Escape: () => cancel(),
  });

  if (!entry) return <LoadingState caption="Loading entry…" />;
  if (entry.notFound) return (
    <div class="pane-empty">
      <h3>Entry not found</h3>
      <p>This knowledge entry may have been deleted.</p>
    </div>
  );

  async function destroy() {
    try {
      await api.deleteKb(slug);
      pushToast("Entry deleted", { variant: "success" });
      onDeleted?.();
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  const title = isNew ? "New entry" : entry.title;
  const categoryKey = (entry.category || "").toLowerCase();
  const categoryAttr = categoryKey.includes("how") ? "howto"
    : categoryKey.includes("policy") ? "policy"
    : categoryKey.includes("ref") ? "reference"
    : null;
  const tagCount = Array.isArray(entry.tags) ? entry.tags.length : 0;
  const slugLabel = isNew ? "" : slug;
  const selectedProject = projects.find((project) => project.id === entry.project_id) || null;
  const saveButtonVariant = isDirty || isNew ? "primary" : "secondary";
  const saveButtonLabel = isNew ? "Create" : "Save";
  const saveDisabled = !entry.title.trim();
  const usageTaskCount = usage?.tasks?.length || 0;
  const usageAgentCount = usage?.agents?.length || 0;
  const contextMeta = [
    !isNew ? { label: "Slug", value: slugLabel } : null,
    { label: "Project", value: selectedProject?.name || "Global", mono: false },
    { label: "Category", value: entry.category || "Uncategorized", mono: false },
    { label: "Subcategory", value: entry.subcategory || "None", mono: false },
    { label: "Tags", value: `${tagCount}`, mono: false },
    { label: "Source task", value: entry.source_task_key || entry.source_task_id, mono: false },
    { label: "Source run", value: entry.source_run_id, mono: true },
    { label: "Source agent", value: entry.source_agent, mono: false },
    { label: "Related", value: cleanList(entry.related_slugs).length ? cleanList(entry.related_slugs).join(", ") : "", mono: false },
    { label: "Supersedes", value: cleanList(entry.supersedes_slugs).length ? cleanList(entry.supersedes_slugs).join(", ") : "", mono: false },
    { label: "Canonical", value: entry.canonical_slug, mono: true },
    { label: "Pinned", value: entry.pinned ? "Yes" : "No", mono: false },
    !isNew ? { label: "Used by tasks", value: `${usageTaskCount}`, mono: false } : null,
    !isNew ? { label: "Used by agents", value: `${usageAgentCount}`, mono: false } : null,
  ].filter(Boolean);
  const headerActions = (
    <>
      {entry.pinned && <Chip variant="accent" leading={<Icon name="pin" size={10} />}>Pinned</Chip>}
      {categoryAttr && <span class="kb-category-badge" data-category={categoryAttr}>{entry.category}</span>}
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        loading={formSave.saving}
        disabled={saveDisabled}
        onClick={() => formSave.save().catch(() => {})}
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
        disabled={saveDisabled}
        onClick={() => formSave.save().catch(() => {})}
      >
        {saveButtonLabel}
      </Button>
    </>
  );

  function renderKbRail() {
    return (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="Context" class="entity-rail-card">
          <EntityMetaList items={contextMeta} />
        </Card>

        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }} class="entity-rail-card">
            <Button
              variant="destructive"
              iconLeft={<Icon name="trash" size={13} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete entry
            </Button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={isNew ? "New entry" : slugLabel} backLabel="Knowledge" onBack={cancel} />,
          mobileActionDock,
          drawerTitle: "Details",
          drawerKicker: isNew ? "New" : slugLabel,
          drawerContent: renderKbRail(),
          sections: KB_EDIT_SECTIONS,
        }}
      />
      <DetailHead
        class="knowledge-detail-head"
        icon={<Icon name={entry.pinned ? "pin" : "book"} size={16} />}
        iconClass={`knowledge-detail-icon ${entry.pinned ? "pinned" : ""}`.trim()}
        kicker={isNew ? "Create entry" : "Knowledge"}
        title={title || "(untitled)"}
        meta={(
          <>
            {!isNew && (
              <>
                <span class="pane-row-mono">{slugLabel}</span>
                <span class="pane-row-dot">·</span>
              </>
            )}
            <span>{tagCount} tag{tagCount === 1 ? "" : "s"}</span>
          </>
        )}
        actions={headerActions}
        subBar={<MobilePillRow railLabel="Details" railCount={isNew ? 1 : 2} sections={KB_EDIT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body knowledge-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}

        <div class="entity-editor-layout knowledge-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="kb-edit-details" num="01" kicker="Details" meta="Metadata" />
            <FormSection kicker="Metadata" title="Entry details">
              <FormGrid columns={2}>
                <FormField label="Title" required>
                  <Input value={entry.title} onInput={(e) => setEntry({ ...entry, title: e.target.value })} placeholder="Entry title" />
                </FormField>
                <FormField label="Category">
                  <Select
                    variant="native"
                    value={entry.category || ""}
                    options={CATEGORY_OPTIONS}
                    onChange={(category) => setEntry({ ...entry, category })}
                    ariaLabel="Knowledge category"
                  />
                </FormField>
                <FormField label="Project">
                  <ProjectPicker
                    value={entry.project_id || ""}
                    projects={projects}
                    onChange={(projectId) => setEntry({ ...entry, project_id: projectId || "" })}
                    clearLabel="Global"
                    ariaLabel="Knowledge project"
                  />
                </FormField>
                <FormField label="Subcategory">
                  <Input value={entry.subcategory} onInput={(e) => setEntry({ ...entry, subcategory: e.target.value })} placeholder="runtime, ui-audit, migration" />
                </FormField>
                <FormField label="Tags">
                  <TagInput value={entry.tags || []} onChange={(tags) => setEntry({ ...entry, tags })} placeholder="Add tag..." suggestions={tagSuggestions} />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={!!entry.pinned}
                    onChange={(next) => setEntry({ ...entry, pinned: next })}
                    label="Pinned in agent context"
                    description="Pinned entries are inserted into agent context."
                  />
                </FormField>
              </FormGrid>
              {!isNew && <AdvancedMeta items={[{ label: "Slug", value: slug }]} />}
            </FormSection>

            <SectionMarker id="kb-edit-body" num="02" kicker="Body" meta="Markdown" />
            <FormSection kicker="Content" title="Body (Markdown)">
              <MentionableTextarea rows={22} monospace autoGrow value={entry.body} onInput={(e) => setEntry({ ...entry, body: e.target.value })} />
            </FormSection>

            <SectionMarker id="kb-edit-references" num="03" kicker="References" meta="Source" />
            <FormSection kicker="References" title="Source and relationships">
              <FormGrid columns={2}>
                <FormField label="Source task key">
                  <Input value={entry.source_task_key} onInput={(e) => setEntry({ ...entry, source_task_key: e.target.value })} placeholder="T-123" />
                </FormField>
                <FormField label="Source task id">
                  <Input value={entry.source_task_id} onInput={(e) => setEntry({ ...entry, source_task_id: e.target.value })} placeholder="task_..." />
                </FormField>
                <FormField label="Source run id">
                  <Input value={entry.source_run_id} onInput={(e) => setEntry({ ...entry, source_run_id: e.target.value })} placeholder="run-..." />
                </FormField>
                <FormField label="Source agent">
                  <Input value={entry.source_agent} onInput={(e) => setEntry({ ...entry, source_agent: e.target.value })} placeholder="agent name" />
                </FormField>
                <FormField label="Related entries">
                  <TagInput value={entry.related_slugs || []} onChange={(related_slugs) => setEntry({ ...entry, related_slugs })} placeholder="knowledge-slug" />
                </FormField>
                <FormField label="Supersedes entries">
                  <TagInput value={entry.supersedes_slugs || []} onChange={(supersedes_slugs) => setEntry({ ...entry, supersedes_slugs })} placeholder="older-slug" />
                </FormField>
                <FormField label="Canonical entry">
                  <Input value={entry.canonical_slug} onInput={(e) => setEntry({ ...entry, canonical_slug: e.target.value })} placeholder="canonical-slug" />
                </FormField>
              </FormGrid>
            </FormSection>

            {!isNew && usage && (usage.tasks?.length || usage.agents?.length) > 0 && (
              <FormSection kicker="Usage" title="Used by">
                  {usage.tasks?.length > 0 && (
                    <FormField label={`Tasks (${usage.tasks.length})`}>
                      <ul class="usage-list">
                        {usage.tasks.map((t) => (
                          <li key={t.id}>
                            <EntityBadge kind="task" label={t.title} href={`#/tasks/${taskRouteId(t)}`} />{" "}
                            <StatusPill status={t.stage || "plan"} size="sm" />
                          </li>
                        ))}
                      </ul>
                    </FormField>
                  )}
                  {usage.agents?.length > 0 && (
                    <FormField label={`Agents (${usage.agents.length})`}>
                      <ul class="usage-list">
                        {usage.agents.map((a) => (
                          <li key={a.name}>
                            <EntityBadge kind="agent" label={agentLabel(a, a.name)} id={a.name} href={`#/library/agents/${encodeURIComponent(a.name)}`} />
                          </li>
                        ))}
                      </ul>
                    </FormField>
                  )}
              </FormSection>
            )}
          </main>

          <aside class="entity-editor-rail is-mobile-drawer-source">
            {renderKbRail()}
          </aside>
        </div>
      </div>

      <EntityEditorModals
        deleteOpen={deleteOpen}
        setDeleteOpen={setDeleteOpen}
        deleteTitle={`Delete "${title}"?`}
        deleteMessage="This removes the entry permanently."
        onDelete={destroy}
        guard={guard}
        saving={formSave.saving}
      />
    </>
  );
}
