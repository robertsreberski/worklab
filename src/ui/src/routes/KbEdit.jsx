// src/ui/src/routes/KbEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { EMPTY_KB_FORM_ENTRY, normalizeKbFormEntry } from "./kb-entry-form.js";

export function KbEdit({ slug }) {
  const isNew = slug === "new";
  const [entry, setEntry] = useState(isNew ? EMPTY_KB_FORM_ENTRY : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugError, setSlugError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSlugError(null);
    setSlugTouched(false);
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
    return () => { cancelled = true; };
  }, [slug, isNew]);

  if (!entry) return <div>Loading...</div>;
  if (entry.notFound) return <div>Entry not found. <a href="#/knowledge">Back</a></div>;

  function validateSlug(val) {
    if (!val) return "Slug is required.";
    if (!/^[a-z0-9-]+$/.test(val)) return "Slug may only contain lowercase letters, digits, and hyphens.";
    return null;
  }

  function parseTags(raw) {
    return raw.split(",").map(t => t.trim()).filter(Boolean);
  }

  async function save() {
    if (isNew) {
      const err = validateSlug(entry.slug);
      if (err) { setSlugError(err); setSlugTouched(true); return; }
    }
    if (!entry.title.trim()) { setError("Title is required."); return; }

    setSaving(true);
    setError(null);
    try {
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
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    if (!confirm(`Delete entry "${slug}"?`)) return;
    await api.deleteKb(slug);
    window.location.hash = "#/knowledge";
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
          <button class="primary" onClick={save} disabled={saving || !entry.title.trim() || (isNew && !entry.slug)}>
            {saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
          {!isNew && <button onClick={destroy} class="danger">Delete</button>}
        </div>
      </section>
      {error && <div class="surface-panel compact status-line error">{error}</div>}

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
            <label class="choice-label">
              <input
                type="checkbox"
                checked={entry.pinned}
                onChange={(e) => setEntry({ ...entry, pinned: e.target.checked })}
              />
              <span>Pinned</span>
            </label>
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
    </div>
  );
}
