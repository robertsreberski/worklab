// src/ui/src/routes/KbEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const emptyEntry = { slug: "", title: "", category: "", tags: "", pinned: false, body: "" };

export function KbEdit({ slug }) {
  const isNew = slug === "new";
  const [entry, setEntry] = useState(isNew ? emptyEntry : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugError, setSlugError] = useState(null);

  useEffect(() => {
    if (!isNew) {
      api.getKb(slug)
        .then(r => {
          const e = r.entry;
          setEntry({
            slug: e.slug,
            title: e.title,
            category: e.category || "",
            tags: (e.tags || []).join(", "),
            pinned: !!e.pinned,
            body: e.body || "",
          });
        })
        .catch(() => setEntry({ notFound: true }));
    }
  }, [slug, isNew]);

  if (!entry) return <div>Loading…</div>;
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
    <div class="detail">
      <a href="#/knowledge">← Back</a>
      <h2>{isNew ? "New KB entry" : entry.title}</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}

      <div class="field">
        <label>Title <span style="color:#ff7a7a">*</span></label>
        <input
          value={entry.title}
          onInput={(e) => setEntry({ ...entry, title: e.target.value })}
          placeholder="Entry title"
        />
      </div>

      <div class="field">
        <label>Slug <span style="color:#ff7a7a">*</span></label>
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
        {slugError && <div class="meta" style="color:#ff7a7a;margin-top:4px">{slugError}</div>}
      </div>

      <div class="field">
        <label>Category</label>
        <input
          value={entry.category}
          onInput={(e) => setEntry({ ...entry, category: e.target.value })}
          placeholder="e.g. reference, howto, …"
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

      <div class="field">
        <label>
          <input
            type="checkbox"
            checked={entry.pinned}
            onChange={(e) => setEntry({ ...entry, pinned: e.target.checked })}
            style="margin-right:6px"
          />
          Pinned ⭐
        </label>
      </div>

      <div class="field">
        <label>Body (markdown)</label>
        <textarea
          rows="20"
          value={entry.body}
          onInput={(e) => setEntry({ ...entry, body: e.target.value })}
          style="font-family:ui-monospace,Menlo,Monaco,monospace"
        />
      </div>

      <button class="primary" onClick={save} disabled={saving || !entry.title.trim() || (isNew && !entry.slug)}>
        {saving ? "Saving…" : (isNew ? "Create" : "Save")}
      </button>
      {!isNew && (
        <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">
          Delete
        </button>
      )}
    </div>
  );
}
