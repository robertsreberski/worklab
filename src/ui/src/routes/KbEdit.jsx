// §6.7 KbEdit — metadata · body · references.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { Icon } from "../components/Icon.jsx";
import { EMPTY_KB_FORM_ENTRY, normalizeKbFormEntry } from "./kb-entry-form.js";
import { useUnsavedChangesGuard } from "../lib/navigation.js";

export function KbEdit({ slug, onSaved, onDeleted }) {
  const isNew = slug === "new";
  const [entry, setEntry] = useState(isNew ? EMPTY_KB_FORM_ENTRY : null);
  const [baseline, setBaseline] = useState(null);
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

  const isDirty = useMemo(() => baseline ? JSON.stringify(entry) !== JSON.stringify(baseline) : true, [entry, baseline]);
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });

  function parseTags(raw) {
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  }

  const formSave = useFormSave(async () => {
    if (!entry.title.trim()) throw new Error("Title is required.");
    const payload = {
      title: entry.title.trim(),
      body: entry.body,
      tags: parseTags(entry.tags),
      category: entry.category.trim() || null,
      pinned: !!entry.pinned,
    };
    if (isNew) {
      const res = await api.createKb(payload);
      pushToast("Entry created", { variant: "success" });
      setBaseline(entry);
      onSaved?.(res.entry.slug);
    } else {
      await api.patchKb(slug, payload);
      pushToast("Saved.", { variant: "success" });
      setBaseline(entry);
      onSaved?.(slug);
    }
  });

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
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
  const tagCount = parseTags(entry.tags || "").length;
  const slugLabel = isNew ? "Slug after create" : slug;

  return (
    <>
      <header class="pane-detail-head knowledge-detail-head">
        <div class="pane-detail-head-copy">
          <div class={`pane-detail-icon knowledge-detail-icon ${entry.pinned ? "pinned" : ""}`.trim()} aria-hidden="true">
            <Icon name={entry.pinned ? "pin" : "book"} size={16} />
          </div>
          <div class="pane-detail-head-titles">
            <div class="all-caps">{isNew ? "Create entry" : "Knowledge"}</div>
            <h2>{title || "(untitled)"}</h2>
            <div class="pane-detail-subline">
              <span class="pane-row-mono">{slugLabel}</span>
              <span class="pane-row-dot">·</span>
              <span>{tagCount} tag{tagCount === 1 ? "" : "s"}</span>
            </div>
          </div>
        </div>
        <div class="toolbar">
          {entry.pinned && <Chip variant="accent" leading={<Icon name="pin" size={10} />}>Pinned</Chip>}
          {categoryAttr && <span class="kb-category-badge" data-category={categoryAttr}>{entry.category}</span>}
          <Button
            variant={isDirty || isNew ? "primary" : "secondary"}
            loading={formSave.saving}
            disabled={!entry.title.trim()}
            onClick={() => formSave.save().catch(() => {})}
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      </header>
      <div class="pane-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}

        <FormSection kicker="Metadata" title="Entry details">
          <FormGrid columns={2}>
            <FormField label="Title" required>
              <Input value={entry.title} onInput={(e) => setEntry({ ...entry, title: e.target.value })} placeholder="Entry title" />
            </FormField>
            <FormField label="Category">
              <Input value={entry.category} onInput={(e) => setEntry({ ...entry, category: e.target.value })} placeholder="reference, howto, policy" />
            </FormField>
            <FormField label="Tags" hint="Comma-separated">
              <Input value={entry.tags} onInput={(e) => setEntry({ ...entry, tags: e.target.value })} placeholder="api, setup, tutorial" />
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

        <FormSection kicker="Content" title="Body (Markdown)">
          <Textarea rows={22} monospace autoGrow value={entry.body} onInput={(e) => setEntry({ ...entry, body: e.target.value })} />
        </FormSection>

        {!isNew && usage && (usage.tasks?.length || usage.agents?.length) > 0 && (
          <FormSection kicker="References" title="Used by">
            {usage.tasks?.length > 0 && (
              <FormField label={`Tasks (${usage.tasks.length})`}>
                <ul class="usage-list">
                  {usage.tasks.map((t) => (
                    <li key={t.id}>
                      <a href={`#/tasks/${t.id}`}>{t.title}</a>{" "}
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
        )}

        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }}>
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
        size="sm"
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
