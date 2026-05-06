// §6.7 Knowledge — pane layout with filter Tabs.
import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { AppShell } from "../components/AppShell.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { PaneListHeader } from "../components/layout/index.js";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { KbEdit } from "./KbEdit.jsx";
import { KbDetail } from "./KbDetail.jsx";
import { navigateHash } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";

function tokenForBadge(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("how")) return "howto";
  if (c.includes("policy")) return "policy";
  if (c.includes("ref")) return "reference";
  return c.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null;
}

function optionLabel(value, fallback = "Uncategorized") {
  if (!value) return fallback;
  return String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function uniqueOptions(entries, key, allLabel, noneLabel = "Uncategorized") {
  const values = [...new Set(entries.map((entry) => entry[key] || "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return [
    { value: "all", label: allLabel },
    ...values.map((value) => ({ value, label: optionLabel(value, noneLabel) })),
  ];
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

export function Knowledge({ selectedSlug = null, mode = null, query: routeQuery = {} }) {
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [category, setCategory] = useState("all");
  const [subcategory, setSubcategory] = useState("all");
  const [tag, setTag] = useState("all");
  const [pinned, setPinned] = useState("all");
  const [surface, setSurface] = useState("canonical");
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    api.listKb(null, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setEntries(r.entries || []); })
      .catch((err) => { if (err?.name !== "AbortError") setEntries([]); });
  }, []);
  const reloadSoon = useThrottledCallback(reload, 100);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);
  useEffect(() => {
    let cancelled = false;
    api.listProjects({ include_archived: "true" })
      .then((res) => { if (!cancelled) setProjects(res.projects || []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);
  useSSE("global", (evt) => { if (evt.type?.startsWith("kb_")) reloadSoon(); });
  useAppResume(reloadSoon);
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
    if (projectId !== "all") list = list.filter((e) => (e.project_id || "") === projectId);
    if (category !== "all") list = list.filter((e) => (e.category || "") === category);
    if (subcategory !== "all") list = list.filter((e) => (e.subcategory || "") === subcategory);
    if (tag !== "all") list = list.filter((e) => (e.tags || []).includes(tag));
    if (pinned === "pinned") list = list.filter((e) => e.pinned);
    else if (pinned === "unpinned") list = list.filter((e) => !e.pinned);
    if (surface === "canonical") list = list.filter((e) => !e.auto_promoted);
    else if (surface === "run_outputs") list = list.filter((e) => e.auto_promoted);
    if (q) {
      list = list.filter((e) =>
        e.title?.toLowerCase().includes(q) ||
        e.slug?.toLowerCase().includes(q) ||
        e.project?.name?.toLowerCase().includes(q) ||
        e.project?.slug?.toLowerCase().includes(q) ||
        e.category?.toLowerCase().includes(q) ||
        e.subcategory?.toLowerCase().includes(q) ||
        (e.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (knowledgeTimestamp(b.updated_at) || 0) - (knowledgeTimestamp(a.updated_at) || 0);
    });
  }, [entries, query, projectId, category, subcategory, tag, pinned, surface]);

  const projectOptions = useMemo(() => [
    { value: "all", label: "All projects" },
    ...projects.map((project) => ({ value: project.id, label: project.name || project.slug, description: project.slug })),
  ], [projects]);
  const categoryOptions = useMemo(() => uniqueOptions(entries, "category", "All categories"), [entries]);
  const subcategoryOptions = useMemo(() => uniqueOptions(entries, "subcategory", "All subcategories", "None"), [entries]);
  const tagOptions = useMemo(() => [
    { value: "all", label: "All tags" },
    ...[...new Set(entries.flatMap((entry) => entry.tags || []))]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: value })),
  ], [entries]);
  const pinnedOptions = [
    { value: "all", label: "All pins" },
    { value: "pinned", label: "Pinned" },
    { value: "unpinned", label: "Unpinned" },
  ];
  const surfaceOptions = [
    { value: "canonical", label: "Canonical" },
    { value: "run_outputs", label: "Run outputs" },
    { value: "all", label: "All entries" },
  ];
  const hasFilter = query.trim() || projectId !== "all" || category !== "all" || subcategory !== "all" || tag !== "all" || pinned !== "all" || surface !== "canonical";

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
      <div class="knowledge-filter-row">
        <Select value={projectId} options={projectOptions} onChange={setProjectId} ariaLabel="Filter knowledge by project" />
        <Select value={category} options={categoryOptions} onChange={setCategory} ariaLabel="Filter knowledge by category" />
        <Select value={subcategory} options={subcategoryOptions} onChange={setSubcategory} ariaLabel="Filter knowledge by subcategory" />
        <Select value={tag} options={tagOptions} onChange={setTag} ariaLabel="Filter knowledge by tag" />
        <Select value={pinned} options={pinnedOptions} onChange={setPinned} ariaLabel="Filter knowledge by pin state" />
        <Select value={surface} options={surfaceOptions} onChange={setSurface} ariaLabel="Filter generated run outputs" />
      </div>
    </PaneListHeader>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No entries match." onClearFilters={() => { setQuery(""); setProjectId("all"); setCategory("all"); setSubcategory("all"); setTag("all"); setPinned("all"); setSurface("canonical"); }} />
    ) : (
      <EmptyState
        title="No entries yet"
        body="Save reusable context here so agents and teammates can find it later."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/knowledge/new"); }}>New entry</Button>}
      />
    )
  ) : (
    filtered.map((e) => {
      const cat = tokenForBadge(e.category);
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
              {e.project?.slug && <span class="pane-row-mono">{e.project.slug}</span>}
              {e.auto_promoted && <span class="kb-category-badge" data-category="run-results">run output</span>}
              {e.category && <span class="kb-category-badge" data-category={cat}>{e.category}</span>}
              {e.subcategory && <span class="kb-category-badge" data-category={tokenForBadge(e.subcategory)}>{e.subcategory}</span>}
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

  const isEditing = selectedSlug === "new" || mode === "edit";
  const detail = selectedSlug ? (
    isEditing ? (
      <KbEdit
        key={`${selectedSlug}:${mode || "create"}`}
        slug={selectedSlug}
        onSaved={() => { reload(); }}
        onDeleted={() => { reload(); window.location.hash = "#/knowledge"; }}
        prefill={isEditing && selectedSlug === "new" ? routeQuery : null}
      />
    ) : (
      <KbDetail key={selectedSlug} slug={selectedSlug} />
    )
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
        detailOwnsMobileBack={!!selectedSlug}
        onBack={() => navigateHash("#/knowledge")}
        backLabel="All entries"
      />
    </AppShell>
  );
}
