// §6.7 KbEdit — metadata · body · references.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { TagInput } from "../components/primitives/SpecialInputs.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { MobilePillRow, MobileTopbar, useAppChrome } from "../components/AppShell.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { Icon } from "../components/Icon.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { EMPTY_KB_FORM_ENTRY, normalizeKbFormEntry } from "./kb-entry-form.js";
import { proceedToHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { taskRouteId } from "../lib/display.js";
import { useAppResume } from "../lib/pageVisibility.js";

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

function EntityChromeBridge({ chrome }) {
  useAppChrome(chrome, [chrome]);
  return null;
}

export function KbEdit({ slug, onSaved, onDeleted }) {
  const isNew = slug === "new";
  const [entry, setEntry] = useState(isNew ? EMPTY_KB_FORM_ENTRY : null);
  const [baseline, setBaseline] = useState(null);
  const [projects, setProjects] = useState([]);
  const [usage, setUsage] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    if (isNew) {
      setEntry(EMPTY_KB_FORM_ENTRY);
      setBaseline(EMPTY_KB_FORM_ENTRY);
      return () => { cancelled = true; };
    }
    setEntry(null);
    api.getKb(slug)
      .then((r) => { if (!cancelled) { const n = normalizeKbFormEntry(r.entry); setEntry(n); setBaseline(n); } })
      .catch(() => { if (!cancelled) setEntry({ notFound: true }); });
    api.kbUsage(slug).then((r) => { if (!cancelled) setUsage(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [slug, isNew]);

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
      pinned: !!entry.pinned,
    };
    if (isNew) {
      const res = await api.createKb(payload);
      const savedSlug = res.entry?.meta?.slug || res.entry?.slug;
      pushToast("Entry created", { variant: "success" });
      setBaseline(entry);
      onSaved?.(savedSlug);
      if (navigateOnSuccess && savedSlug) proceedToHash(`#/knowledge/${savedSlug}`);
    } else {
      await api.patchKb(slug, payload);
      pushToast("Saved.", { variant: "success" });
      setBaseline(entry);
      onSaved?.(slug);
      if (navigateOnSuccess) proceedToHash(`#/knowledge/${slug}`);
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
  const cancel = () => guard.requestNavigation(isNew ? "#/knowledge" : `#/knowledge/${slug}`);

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
    Escape: () => cancel(),
  });

  const projectOptions = useMemo(() => [
    { value: "", label: "Global" },
    ...projects.map((project) => ({
      value: project.id,
      label: project.name || project.slug,
      description: project.slug,
    })),
  ], [projects]);

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
  const slugLabel = isNew ? "Slug after create" : slug;
  const selectedProject = projects.find((project) => project.id === entry.project_id) || null;
  const saveButtonVariant = isDirty || isNew ? "primary" : "secondary";
  const saveButtonLabel = isNew ? "Create" : "Save";
  const saveDisabled = !entry.title.trim();
  const usageTaskCount = usage?.tasks?.length || 0;
  const usageAgentCount = usage?.agents?.length || 0;
  const contextMeta = [
    { label: "Slug", value: slugLabel },
    { label: "Project", value: selectedProject?.name || "Global", mono: false },
    { label: "Category", value: entry.category || "Uncategorized", mono: false },
    { label: "Subcategory", value: entry.subcategory || "None", mono: false },
    { label: "Tags", value: `${tagCount}`, mono: false },
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
          drawerKicker: slugLabel,
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
            <span class="pane-row-mono">{slugLabel}</span>
            <span class="pane-row-dot">·</span>
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
                  <Select
                    value={entry.project_id || ""}
                    options={projectOptions}
                    onChange={(projectId) => setEntry({ ...entry, project_id: projectId || "" })}
                    ariaLabel="Knowledge project"
                  />
                </FormField>
                <FormField label="Subcategory">
                  <Input value={entry.subcategory} onInput={(e) => setEntry({ ...entry, subcategory: e.target.value })} placeholder="runtime, ui-audit, migration" />
                </FormField>
                <FormField label="Tags">
                  <TagInput value={entry.tags || []} onChange={(tags) => setEntry({ ...entry, tags })} placeholder="Add tag..." />
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
              <AdvancedMeta items={[{ label: "Slug", value: isNew ? "Generated after create" : slug }]} />
            </FormSection>

            <SectionMarker id="kb-edit-body" num="02" kicker="Body" meta="Markdown" />
            <FormSection kicker="Content" title="Body (Markdown)">
              <Textarea rows={22} monospace autoGrow value={entry.body} onInput={(e) => setEntry({ ...entry, body: e.target.value })} />
            </FormSection>

            {!isNew && usage && (usage.tasks?.length || usage.agents?.length) > 0 && (
              <>
                <SectionMarker id="kb-edit-references" num="03" kicker="References" meta="Usage" />
                <FormSection kicker="References" title="Used by">
                  {usage.tasks?.length > 0 && (
                    <FormField label={`Tasks (${usage.tasks.length})`}>
                      <ul class="usage-list">
                        {usage.tasks.map((t) => (
                          <li key={t.id}>
                            <a href={`#/tasks/${taskRouteId(t)}`}>{t.title}</a>{" "}
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
                            <a href={`#/agents/${a.name}`}>{a.display_name || a.name}</a>
                          </li>
                        ))}
                      </ul>
                    </FormField>
                  )}
                </FormSection>
              </>
            )}
          </main>

          <aside class="entity-editor-rail is-mobile-drawer-source">
            {renderKbRail()}
          </aside>
        </div>
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete "${title}"?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        }
      >
        <p>This removes the entry permanently.</p>
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
