// src/ui/src/routes/Knowledge.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { EmptyState } from "../components/EmptyState.jsx";

export function Knowledge() {
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const reload = useCallback(() => {
    api.listKb().then(r => setEntries(r.entries));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("kb_")) reload(); });

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.search({ q, kind: "kb", limit: 8 });
        if (!cancelled) setSearchResults(res.results || []);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const filtered = query.trim()
    ? entries.filter(e => {
        const q = query.toLowerCase();
        return e.title.toLowerCase().includes(q) ||
          (e.tags || []).some(t => t.toLowerCase().includes(q));
      })
    : entries;
  const showingSearch = query.trim().length > 0;

  return (
    <div class="detail page-stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Shared context</div>
          <h2 class="page-title">Knowledge base</h2>
          <div class="page-copy">{entries.length} entries</div>
        </div>
        <a href="#/knowledge/new" class="primary">New entry</a>
      </div>

      <div class="surface-panel compact">
        <div class="field">
          <label>Search</label>
          <input
            type="search"
            placeholder="Search knowledge by title, tag, or content..."
            value={query}
            onInput={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {showingSearch && (
        <div class="search-section">
          <div class="list-header">
            <div>
              <div class="section-kicker">Indexed content</div>
              <h3 class="section-title">
                {searching ? "Searching..." : `${searchResults.length} indexed result${searchResults.length === 1 ? "" : "s"}`}
              </h3>
            </div>
          </div>
          <div class="search-results">
            {searchResults.length === 0 && !searching && (
              <div class="surface-panel compact meta">No indexed content matches. Title and tag matches are still shown below.</div>
            )}
            {searchResults.map((result) => (
              <a key={result.ref} class="search-result" href={result.slug ? `#/knowledge/${result.slug}` : "#/knowledge"}>
                <strong>{result.title}</strong>
                <span class="meta">{result.snippet || result.source_ref}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 && entries.length === 0 && (
        <EmptyState
          icon="📚"
          title="No knowledge base entries yet"
          body="Pinned entries are inlined into every agent's system prompt. Add notes, references, or step-by-step playbooks here."
          cta={<a href="#/knowledge/new" class="primary">Create the first entry</a>}
        />
      )}

      {filtered.length === 0 && entries.length > 0 && (
        <div class="meta">No entries match "{query}".</div>
      )}

      {filtered.length > 0 && (
        <table class="knowledge-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Tags</th>
              <th class="center-cell">Pinned</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(e => (
              <tr key={e.slug}
                onClick={() => { window.location.hash = `#/knowledge/${e.slug}`; }}>
                <td data-label="Title">
                  <a href={`#/knowledge/${e.slug}`} class="title-link"
                    onClick={(ev) => ev.stopPropagation()}>
                    {e.title}
                  </a>
                </td>
                <td data-label="Category" class="meta">{e.category || "-"}</td>
                <td data-label="Tags" class="meta">
                  {(e.tags || []).length > 0
                    ? (e.tags || []).join(", ")
                    : "-"}
                </td>
                <td data-label="Pinned" class="center-cell">
                  {e.pinned ? <span class="status-badge in_review">Pinned</span> : ""}
                </td>
                <td data-label="Updated" class="meta">
                  {e.updated_at ? new Date(e.updated_at).toLocaleDateString() : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
