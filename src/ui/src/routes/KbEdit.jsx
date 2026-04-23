// src/ui/src/routes/KbEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { CheckboxField } from "../components/CheckboxField.jsx";
import { EMPTY_KB_FORM_ENTRY, normalizeKbFormEntry } from "./kb-entry-form.js";

export function KbEdit({ slug }) {
  const isNew = slug === "new";
  const [entry, setEntry] = useState(isNew ? EMPTY_KB_FORM_ENTRY : null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugError, setSlugError] = useState(null);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSlugError(null);
    setSlugTouched(false);
    setUsage(null);
    if (isNew) {
      setEntry(EMPTY_KB_FORM_ENTRY);
      return () => { cancelled = true; };
    }
    setEntry(null);
    api.getKb(slug)
      .then(r => {
        if (cancelled) return;
        setEntry(normalizeKbFormEntry(r.entry));
      })
      .catch(() => {
        if (!cancelled) setEntry({ notFound: true });
      });
    api.kbUsage(slug)
      .then((r) => { if (!cancelled) setUsage(r); })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [slug, isNew]);

  function validateSlug(val) {
    if (!val) return "Slug is required.";
    if (!/^[a-z0-9-]+$/.test(val)) return "Slug may only contain lowercase letters, digits, and hyphens.";
    return null;
  }

  function parseTags(raw) {
    return raw.split(",").map(t => t.trim()).filter(Boolean);
  }

  const formSave = useFormSave(async () => {
    if (isNew) {
      const err = validateSlug(entry.slug);
      if (err) { setSlugError(err); setSlugTouched(true); throw new Error(err); }
    }
    if (!entry.title.trim()) throw new Error("Title is required.");

    const payload = {
      title: entry.title.trim(),
      body: entry.body,
      tags: parseTags(entry.tags),
      category: entry.category.trim() || null,
      pinned: !!entry.pinned,
    };
    if (isNew) {
      await api.createKb({ slug: entry.slug, ...payload });
    } else {
      await api.patchKb(slug, payload);
    }
    window.location.hash = "#/knowledge";
  });

  if (!entry) return <div>Loading...</div>;
  if (entry.notFound) return <div>Entry not found. <a href="#/knowledge">Back</a></div>;

  async function destroy() {
    try {
      await api.deleteKb(slug);
      window.location.hash = "#/knowledge";
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  return (
    <div class="detail page-stack">
      <a href="#/knowledge" class="back-link">Back to knowledge</a>
      <section class="surface-panel task-hero">
        <div>
          <div class="eyebrow">Knowledge</div>
          <h2>{isNew ? "New entry" : entry.title}</h2>
          <div class="task-meta-grid">
            <span class={entry.pinned ? "status-badge in_review" : "status-badge muted"}>{entry.pinned ? "Pinned" : "Not pinned"}</span>
            <span class="meta-pill">{entry.category || "Uncategorized"}</span>
          </div>
        </div>
        <div class="toolbar">
          <button class="primary" onClick={() => formSave.save().catch(() => {})} disabled={formSave.saving || !entry.title.trim() || (isNew && !entry.slug)}>
            {formSave.saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
          {!isNew && <ConfirmButton class="danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>}
        </div>
      </section>
      {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}

      <section class="surface-panel">
        <div class="section-kicker">Metadata</div>
        <h3 class="section-title">Entry details</h3>
        <div class="form-grid">
          <div class="field">
            <label>Title *</label>
            <input
              value={entry.title}
              onInput={(e) => setEntry({ ...entry, title: e.target.value })}
              placeholder="Entry title"
            />
          </div>

          <div class="field">
            <label>Slug *</label>
            <input
              value={entry.slug}
              disabled={!isNew}
              placeholder="e.g. my-entry-slug"
              onInput={(e) => {
                setEntry({ ...entry, slug: e.target.value });
                if (slugTouched) setSlugError(validateSlug(e.target.value));
              }}
              onBlur={() => {
                setSlugTouched(true);
                setSlugError(validateSlug(entry.slug));
              }}
            />
            {slugError && <div class="status-line error">{slugError}</div>}
          </div>

          <div class="field">
            <label>Category</label>
            <input
              value={entry.category}
              onInput={(e) => setEntry({ ...entry, category: e.target.value })}
              placeholder="e.g. reference, howto"
            />
          </div>

          <div class="field">
            <label>Tags (comma-separated)</label>
            <input
              value={entry.tags}
              onInput={(e) => setEntry({ ...entry, tags: e.target.value })}
              placeholder="e.g. api, setup, tutorial"
            />
          </div>

          <div class="field span-2">
            <CheckboxField
              checked={entry.pinned}
              onChange={(e) => setEntry({ ...entry, pinned: e.target.checked })}
            >
              Pinned
            </CheckboxField>
          </div>
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Content</div>
        <h3 class="section-title">Markdown body</h3>
        <div class="field">
          <label>Body</label>
          <textarea
            rows="22"
            value={entry.body}
            onInput={(e) => setEntry({ ...entry, body: e.target.value })}
            class="mono-input"
          />
        </div>
      </section>

      {!isNew && usage && (usage.tasks.length || usage.agents.length) > 0 && (
        <section class="surface-panel">
          <div class="section-kicker">References</div>
          <h3 class="section-title">Used by</h3>
          {usage.tasks.length > 0 && (
            <div class="field">
              <label>Tasks ({usage.tasks.length})</label>
              <ul class="usage-list">
                {usage.tasks.map((task) => (
                  <li key={task.id}>
                    <a href={`#/tasks/${task.id}`}>{task.title}</a>
                    <span class={`status-badge ${task.status}`}>{task.status}</span>
                    <span class="meta">via {task.via}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {usage.agents.length > 0 && (
            <div class="field">
              <label>Agent instructions ({usage.agents.length})</label>
              <ul class="usage-list">
                {usage.agents.map((agent) => (
                  <li key={agent.name}>
                    <a href={`#/agents/${agent.name}`}>{agent.display_name || agent.name}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      {!isNew && usage && usage.tasks.length === 0 && usage.agents.length === 0 && (
        <div class="meta">No tasks or agents reference this entry yet.</div>
      )}
    </div>
  );
}
