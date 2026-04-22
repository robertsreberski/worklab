// src/ui/src/routes/Knowledge.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";

export function Knowledge() {
  const [entries, setEntries] = useState([]);
  const [search, setSearch] = useState("");

  const reload = useCallback(() => {
    api.listKb().then(r => setEntries(r.entries));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("kb_")) reload(); });

  const filtered = search.trim()
    ? entries.filter(e => {
        const q = search.toLowerCase();
        return e.title.toLowerCase().includes(q) ||
          (e.tags || []).some(t => t.toLowerCase().includes(q));
      })
    : entries;

  return (
    <div class="detail">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Knowledge Base</h2>
        <a href="#/knowledge/new" class="primary" style="padding:6px 10px;border-radius:4px;background:var(--accent);color:#fff;text-decoration:none">+ New entry</a>
      </div>

      <div class="field" style="margin-bottom:12px">
        <input
          type="search"
          placeholder="Filter by title or tag…"
          value={search}
          onInput={(e) => setSearch(e.target.value)}
          style="width:100%;box-sizing:border-box"
        />
      </div>

      {filtered.length === 0 && entries.length === 0 && (
        <div class="meta" style="text-align:center;padding:32px 0">
          No knowledge base entries yet.{" "}
          <a href="#/knowledge/new">Create the first entry →</a>
        </div>
      )}

      {filtered.length === 0 && entries.length > 0 && (
        <div class="meta">No entries match "{search}".</div>
      )}

      {filtered.length > 0 && (
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--border)">
              <th style="padding:6px 8px">Title</th>
              <th style="padding:6px 8px">Category</th>
              <th style="padding:6px 8px">Tags</th>
              <th style="padding:6px 8px;text-align:center">Pinned</th>
              <th style="padding:6px 8px">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(e => (
              <tr key={e.slug} style="border-bottom:1px solid var(--border);cursor:pointer"
                onClick={() => { window.location.hash = `#/knowledge/${e.slug}`; }}>
                <td style="padding:6px 8px">
                  <a href={`#/knowledge/${e.slug}`} style="color:var(--accent);text-decoration:none"
                    onClick={(ev) => ev.stopPropagation()}>
                    {e.title}
                  </a>
                </td>
                <td style="padding:6px 8px" class="meta">{e.category || "—"}</td>
                <td style="padding:6px 8px" class="meta">
                  {(e.tags || []).length > 0
                    ? (e.tags || []).join(", ")
                    : "—"}
                </td>
                <td style="padding:6px 8px;text-align:center">
                  {e.pinned ? "⭐" : ""}
                </td>
                <td style="padding:6px 8px" class="meta">
                  {e.updated_at ? new Date(e.updated_at).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
