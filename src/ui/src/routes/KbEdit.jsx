import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { SwitchField } from "../components/SwitchField.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { Icon } from "../components/Icon.jsx";
import { EMPTY_KB_FORM_ENTRY, normalizeKbFormEntry } from "./kb-entry-form.js";

export function KbEdit({ slug, onSaved, onDeleted }) {
  const isNew = slug === "new";
  const [entry, setEntry] = useState(isNew ? EMPTY_KB_FORM_ENTRY : null);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    if (isNew) {
      setEntry(EMPTY_KB_FORM_ENTRY);
      return () => { cancelled = true; };
    }
    setEntry(null);
    api.getKb(slug)
      .then((r) => { if (!cancelled) setEntry(normalizeKbFormEntry(r.entry)); })
      .catch(() => { if (!cancelled) setEntry({ notFound: true }); });
    api.kbUsage(slug)
      .then((r) => { if (!cancelled) setUsage(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [slug, isNew]);

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
      onSaved?.(res.entry.slug);
    } else {
      await api.patchKb(slug, payload);
      onSaved?.(slug);
    }
  });

  if (!entry) return <div class="pane-empty">Loading entry...</div>;
  if (entry.notFound) return (
    <div class="pane-empty">
      <h3>Entry not found</h3>
      <p>This knowledge entry may have been deleted.</p>
    </div>
  );

  async function destroy() {
    try {
      await api.deleteKb(slug);
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

  return (
    <>
      <header class="pane-detail-head">
        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <div>
            <div class="eyebrow">{isNew ? "Create entry" : "Knowledge"}</div>
            <h2>{title || "(untitled)"}</h2>
          </div>
        </div>
        <div class="toolbar">
          {entry.pinned && (
            <span class="chip chip-accent">
              <Icon name="pin" size={10} />
              Pinned
            </span>
          )}
          {categoryAttr && (
            <span class="kb-category-badge" data-category={categoryAttr}>
              {entry.category}
            </span>
          )}
          {!isNew && <ConfirmButton class="button danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>}
          <button
            class="button primary"
            onClick={() => formSave.save().catch(() => {})}
            disabled={formSave.saving || !entry.title.trim()}
          >
            {formSave.saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
        </div>
      </header>
      <div class="pane-detail-body">
        {formSave.error && <div class="form-error">Save failed: {formSave.error}</div>}

        <section class="surface-panel">
          <div class="section-kicker">Metadata</div>
          <h3>Entry details</h3>
          <div class="form-grid">
            <div class="field">
              <label class="field-label">Title</label>
              <input
                class="form-input"
                value={entry.title}
                onInput={(e) => setEntry({ ...entry, title: e.target.value })}
                placeholder="Entry title"
              />
            </div>
            <div class="field">
              <label class="field-label">Category</label>
              <input
                class="form-input"
                value={entry.category}
                onInput={(e) => setEntry({ ...entry, category: e.target.value })}
                placeholder="e.g. reference, howto, policy"
              />
            </div>
            <div class="field">
              <label class="field-label">Tags (comma-separated)</label>
              <input
                class="form-input"
                value={entry.tags}
                onInput={(e) => setEntry({ ...entry, tags: e.target.value })}
                placeholder="api, setup, tutorial"
              />
            </div>
            <div class="field">
              <SwitchField
                checked={entry.pinned}
                onChange={(e) => setEntry({ ...entry, pinned: e.target.checked })}
                description="Pinned entries are inserted into agent context."
              >
                Pinned in agent context
              </SwitchField>
            </div>
          </div>
          <AdvancedMeta items={[{ label: "Slug", value: isNew ? "Generated after create" : slug }]} />
        </section>

        <section class="surface-panel">
          <div class="section-kicker">Content</div>
          <h3>Body (Markdown)</h3>
          <div class="field">
            <textarea
              class="form-input mono-input"
              rows="22"
              value={entry.body}
              onInput={(e) => setEntry({ ...entry, body: e.target.value })}
            />
          </div>
        </section>

        {!isNew && usage && (usage.tasks?.length || usage.agents?.length) > 0 && (
          <section class="surface-panel">
            <div class="section-kicker">References</div>
            <h3>Used by</h3>
            {usage.tasks?.length > 0 && (
              <div class="field">
                <label class="field-label">Tasks ({usage.tasks.length})</label>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {usage.tasks.map((t) => (
                    <li key={t.id}>
                      <a href={`#/tasks/${t.id}`}>{t.title}</a>
                      {" "}
                      <StatusPill status={t.status} size="sm" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {usage.agents?.length > 0 && (
              <div class="field">
                <label class="field-label">Agents ({usage.agents.length})</label>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {usage.agents.map((a) => (
                    <li key={a.name}>
                      <a href={`#/agents/${a.name}`}>{a.display_name || a.name}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
