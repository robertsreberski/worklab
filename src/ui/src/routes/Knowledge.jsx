// §6.7 Knowledge — pane layout with filter Tabs.
import { useEffect, useState, useCallback, useMemo } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { KbEdit } from "./KbEdit.jsx";

const CATEGORY_TABS = [
  { value: "all",       label: "All" },
  { value: "reference", label: "Reference" },
  { value: "howto",     label: "How-to" },
  { value: "policy",    label: "Policy" },
  { value: "pinned",    label: "Pinned" },
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

  const hasFilter = query.trim() || category !== "all";

  const listHeader = (
    <>
      <SearchField value={query} onInput={(e) => setQuery(e.target.value)} placeholder="Search knowledge…" />
      <Tabs ariaLabel="Filter by category" value={category} onChange={setCategory} tabs={CATEGORY_TABS} />
      <Button variant="primary" size="sm" iconLeft={<Icon name="plus" size={12} />} onClick={() => { window.location.hash = "#/knowledge/new"; }}>New entry</Button>
    </>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No entries match." onClearFilters={() => { setQuery(""); setCategory("all"); }} />
    ) : (
      <EmptyState
        title="No entries yet"
        body="Knowledge entries are shared context for humans and agents. Pin entries to include them in agent context."
        cta={<Button variant="primary" onClick={() => { window.location.hash = "#/knowledge/new"; }}>New entry</Button>}
      />
    )
  ) : (
    filtered.map((e) => {
      const cat = categoryToken(e.category);
      return (
        <PaneRow
          key={e.slug}
          href={`#/knowledge/${e.slug}`}
          active={e.slug === selectedSlug}
          leading={e.pinned ? <Icon name="pin" size={12} /> : null}
          title={e.title}
          sub={cat ? <span class="kb-category-badge" data-category={cat}>{cat}</span> : null}
          trailing={formatAge(e.updated_at)}
        />
      );
    })
  );

  const detail = selectedSlug ? (
    <KbEdit
      key={selectedSlug}
      slug={selectedSlug}
      onSaved={(slug) => { reload(); if (selectedSlug === "new") window.location.hash = `#/knowledge/${slug}`; }}
      onDeleted={() => { reload(); window.location.hash = "#/knowledge"; }}
    />
  ) : (
    <div class="pane-empty">
      <Icon name="book" size={28} />
      <h3>Select an entry</h3>
      <p>Knowledge entries are shared context for humans and agents.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { window.location.hash = "#/knowledge/new"; }}>New entry</Button>
    </div>
  );

  return (
    <AppShell route="knowledge" title="Knowledge">
      <PaneLayout listHeader={listHeader} listBody={listBody} detail={detail} hasSelection={!!selectedSlug} />
    </AppShell>
  );
}
