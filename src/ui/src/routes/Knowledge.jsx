import { useEffect, useState, useCallback, useMemo } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/SearchField.jsx";
import { Icon } from "../components/Icon.jsx";
import { KbEdit } from "./KbEdit.jsx";

const CATEGORY_TABS = [
  { id: "all", label: "All" },
  { id: "reference", label: "Reference" },
  { id: "howto", label: "How-to" },
  { id: "policy", label: "Policy" },
  { id: "pinned", label: "Pinned" },
];

function categoryToken(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("how")) return "howto";
  if (c.includes("policy")) return "policy";
  if (c.includes("ref")) return "reference";
  return null;
}

function formatAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 86_400_000) return "today";
  const days = Math.floor(ms / 86_400_000);
  if (days < 7) return `${days}d`;
  return new Date(Number(value)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function KbRow({ entry, active }) {
  const cat = categoryToken(entry.category);
  return (
    <a
      href={`#/knowledge/${entry.slug}`}
      class={`pane-row ${active ? "active" : ""}`}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {entry.pinned && <Icon name="pin" size={11} />}
      </span>
      <div class="pane-row-main">
        <div class="pane-row-title">{entry.title}</div>
        <div class="pane-row-sub">
          {cat && <span class="kb-category-badge" data-category={cat}>{cat}</span>}
          {(entry.tags || []).slice(0, 3).map((t) => (
            <span key={t} class="tag" style={{ marginLeft: 4 }}>{t}</span>
          ))}
        </div>
      </div>
      <div class="pane-row-meta">{formatAge(entry.updated_at)}</div>
    </a>
  );
}

export function Knowledge({ selectedSlug = null }) {
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const reload = useCallback(() => {
    api.listKb().then((r) => setEntries(r.entries || [])).catch(() => setEntries([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("kb_")) reload(); });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = entries;
    if (category === "pinned") list = list.filter((e) => e.pinned);
    else if (category !== "all") list = list.filter((e) => categoryToken(e.category) === category);
    if (q) {
      list = list.filter((e) =>
        e.title?.toLowerCase().includes(q) ||
        e.category?.toLowerCase().includes(q) ||
        (e.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0);
    });
  }, [entries, query, category]);

  const headerMeta = (
    <>
      <span>{entries.length} entries</span>
      <span class="dot">·</span>
      <span>{entries.filter((e) => e.pinned).length} pinned</span>
    </>
  );

  return (
    <AppShell route="knowledge" title="Knowledge" headerMeta={headerMeta}>
      <div class="two-pane">
        <aside class="pane-list">
          <div class="pane-list-head">
            <SearchField
              value={query}
              onInput={(e) => setQuery(e.target.value)}
              placeholder="Search knowledge..."
            />
            <div class="pane-list-tabs">
              {CATEGORY_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  class={`filter-pill ${category === t.id ? "active" : ""}`}
                  onClick={() => setCategory(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <a href="#/knowledge/new" class="button primary small" style={{ justifyContent: "center" }}>
              <Icon name="plus" size={12} />
              New entry
            </a>
          </div>
          <div class="pane-list-body wl-hide-scrollbar">
            {filtered.length === 0 && (
              <div class="pane-empty">{query || category !== "all" ? "No entries match." : "No entries yet."}</div>
            )}
            {filtered.map((e) => (
              <KbRow key={e.slug} entry={e} active={e.slug === selectedSlug} />
            ))}
          </div>
        </aside>
        <section class="pane-detail">
          {selectedSlug ? (
            <KbEdit
              key={selectedSlug}
              slug={selectedSlug}
              onSaved={(slug) => {
                reload();
                if (selectedSlug === "new") window.location.hash = `#/knowledge/${slug}`;
              }}
              onDeleted={() => {
                reload();
                window.location.hash = "#/knowledge";
              }}
            />
          ) : (
            <div class="pane-empty">
              <Icon name="book" size={28} />
              <h3>Select an entry</h3>
              <p>Knowledge entries are shared context for humans and agents. Pin entries to include them in agent context.</p>
              <a href="#/knowledge/new" class="button primary">
                <Icon name="plus" size={13} />
                New entry
              </a>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
