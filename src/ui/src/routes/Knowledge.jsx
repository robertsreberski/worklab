// §6.7 Knowledge — pane layout with filter Tabs.
import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { PaneListHeader } from "../components/layout/index.js";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { KbEdit } from "./KbEdit.jsx";
import { navigateHash } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";

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

export function formatKnowledgeAge(value, now = Date.now()) {
  if (!value) return "";
  const timestamp = knowledgeTimestamp(value);
  if (!Number.isFinite(timestamp)) return "";
  const ms = now - timestamp;
  if (ms < 86_400_000) return "today";
  const days = Math.floor(ms / 86_400_000);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function knowledgeTimestamp(value) {
  if (!value) return NaN;
  if (typeof value === "number") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return Date.parse(value);
}

export function Knowledge({ selectedSlug = null }) {
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const searchRef = useRef(null);

  const reload = useCallback(() => {
    api.listKb().then((r) => setEntries(r.entries || [])).catch(() => setEntries([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("kb_")) reload(); });
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = entries;
    if (category === "pinned") list = list.filter((e) => e.pinned);
    else if (category !== "all") list = list.filter((e) => categoryToken(e.category) === category);
    if (q) {
      list = list.filter((e) =>
        e.title?.toLowerCase().includes(q) ||
        e.slug?.toLowerCase().includes(q) ||
        e.category?.toLowerCase().includes(q) ||
        e.body?.toLowerCase().includes(q) ||
        (e.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (knowledgeTimestamp(b.updated_at) || 0) - (knowledgeTimestamp(a.updated_at) || 0);
    });
  }, [entries, query, category]);

  const hasFilter = query.trim() || category !== "all";

  const listHeader = (
    <PaneListHeader
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search knowledge…"
      searchAriaLabel="Search knowledge"
      searchRef={searchRef}
      actionLabel="New entry"
      onAction={() => { navigateHash("#/knowledge/new"); }}
    >
      <Tabs ariaLabel="Filter by category" value={category} onChange={setCategory} tabs={CATEGORY_TABS} />
    </PaneListHeader>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No entries match." onClearFilters={() => { setQuery(""); setCategory("all"); }} />
    ) : (
      <EmptyState
        title="No entries yet"
        body="Save reusable context here so agents and teammates can find it later."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/knowledge/new"); }}>New entry</Button>}
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
          class="knowledge-pane-row"
          onClick={(event) => {
            event?.preventDefault?.();
            navigateHash(`#/knowledge/${e.slug}`);
          }}
          leading={(
            <span class={`knowledge-row-leading ${e.pinned ? "pinned" : ""}`.trim()}>
              <Icon name={e.pinned ? "pin" : "book"} size={12} />
            </span>
          )}
          title={e.title}
          sub={(
            <span class="knowledge-row-sub">
              {cat && <span class="kb-category-badge" data-category={cat}>{cat}</span>}
              <span class="pane-row-mono">{e.slug}</span>
            </span>
          )}
          trailing={(
            <span class="pane-row-summary pane-row-summary-metrics">
              <span>{formatKnowledgeAge(e.updated_at)}</span>
            </span>
          )}
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
        <p>Open an entry to read, edit, or see where it is used.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/knowledge/new"); }}>New entry</Button>
      </div>
  );

  return (
    <AppShell route="knowledge">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedSlug}
        onBack={() => navigateHash("#/knowledge")}
        backLabel="All entries"
      />
    </AppShell>
  );
}
