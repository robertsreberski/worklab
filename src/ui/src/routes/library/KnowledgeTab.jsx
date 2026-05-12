// §6.7 Knowledge — pane layout with filter Tabs.
import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../../lib/api.js";
import { useSSE } from "../../lib/useSSE.js";
import { useThrottledCallback } from "../../lib/useThrottledCallback.js";
import { useAppResume } from "../../lib/pageVisibility.js";
import { Select } from "../../components/primitives/Select.jsx";
import { Tabs } from "../../components/primitives/Tabs.jsx";
import { Button } from "../../components/primitives/Button.jsx";
import { Icon } from "../../components/Icon.jsx";
import { PaneLayout } from "../../components/PaneLayout.jsx";
import { PaneRow } from "../../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../../components/EmptyState.jsx";
import { ResourceGroup, ResourceList, ResourceListToolbar } from "../../components/ResourceListToolbar.jsx";
import { ResourceRowChip, ResourceRowId, ResourceRowTags } from "../../components/ResourceRowMeta.jsx";
import { KbEdit } from "../KbEdit.jsx";
import { KbDetail } from "../KbDetail.jsx";
import { buildKnowledgeResourceGroups, flattenResourceGroups } from "../../lib/resourceLists.js";
import { navigateHash } from "../../lib/navigation.js";
import { useGlobalShortcuts } from "../../lib/useGlobalShortcuts.js";

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

export function KnowledgeTab({ selectedSlug = null, mode = null, query: routeQuery = {} }) {
  const [entries, setEntries] = useState([]);
  const [taxonomy, setTaxonomy] = useState(null);
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [category, setCategory] = useState("all");
  const [subcategory, setSubcategory] = useState("all");
  const [tag, setTag] = useState("all");
  const [pinned, setPinned] = useState("all");
  const [surface, setSurface] = useState("artifacts");
  const [sort, setSort] = useState("pinned_first");
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    Promise.all([
      api.listKb(null, { signal: controller.signal }),
      api.kbTaxonomy({ signal: controller.signal }).catch(() => null),
    ])
      .then(([r, nextTaxonomy]) => {
        if (!controller.signal.aborted) {
          setEntries(r.entries || []);
          setTaxonomy(nextTaxonomy);
        }
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setEntries([]);
          setTaxonomy(null);
        }
      });
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

  const groups = useMemo(() => buildKnowledgeResourceGroups(entries, {
    query,
    projectId,
    category,
    subcategory,
    tag,
    pinned,
    surface,
    sort,
  }), [category, entries, pinned, projectId, query, sort, subcategory, surface, tag]);
  const filtered = useMemo(() => flattenResourceGroups(groups), [groups]);

  const projectOptions = useMemo(() => [
    { value: "all", label: "All projects" },
    ...projects.map((project) => ({ value: project.id, label: project.name || project.slug, description: project.slug })),
  ], [projects]);
  const categoryOptions = useMemo(() => uniqueOptions(entries, "category", "All categories"), [entries]);
  const subcategoryOptions = useMemo(() => uniqueOptions(entries, "subcategory", "All subcategories", "None"), [entries]);
  const tagOptions = useMemo(() => [
    { value: "all", label: "All tags" },
    ...[...new Set([
      ...(taxonomy?.tags || []).map((row) => row.tag),
      ...entries.flatMap((entry) => entry.tags || []),
    ])]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: value })),
  ], [entries, taxonomy]);
  const tagSuggestions = useMemo(() => (taxonomy?.tags || []).map((row) => row.tag).filter(Boolean), [taxonomy]);
  const pinnedOptions = [
    { value: "all", label: "All pins" },
    { value: "pinned", label: "Pinned" },
    { value: "unpinned", label: "Unpinned" },
  ];
  const sortOptions = [
    { value: "pinned_first", label: "Pinned first" },
    { value: "updated_desc", label: "Recent update" },
    { value: "title_asc", label: "Title A-Z" },
    { value: "project_category", label: "Project/category" },
  ];
  const surfaceTabs = [
    { value: "artifacts", label: "Artifacts", count: entries.filter((entry) => !(entry.run_output || entry.auto_promoted)).length },
    { value: "run_outputs", label: "Run outputs", count: entries.filter((entry) => entry.run_output || entry.auto_promoted).length },
    { value: "all", label: "All", count: entries.length },
  ];
  const hasFilter = query.trim() || projectId !== "all" || category !== "all" || subcategory !== "all" || tag !== "all" || pinned !== "all" || surface !== "artifacts";

  const listHeader = (
    <ResourceListToolbar
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search knowledge…"
      searchAriaLabel="Search knowledge"
      searchRef={searchRef}
      countLabel={`${filtered.length} shown`}
      actionLabel="New entry"
      onAction={() => { navigateHash("#/library/knowledge/new"); }}
      configTitle="Knowledge configuration"
      activeConfigCount={[surface !== "artifacts", sort !== "pinned_first", projectId !== "all", category !== "all", subcategory !== "all", tag !== "all", pinned !== "all"].filter(Boolean).length}
    >
      <Tabs value={surface} onChange={setSurface} tabs={surfaceTabs} ariaLabel="Filter knowledge surface" class="tabs-pills" />
      <Select class="resource-filter-select" value={sort} options={sortOptions} onChange={setSort} ariaLabel="Sort knowledge" />
      <Select class="resource-filter-select" value={projectId} options={projectOptions} onChange={setProjectId} ariaLabel="Filter knowledge by project" />
      <Select class="resource-filter-select" value={category} options={categoryOptions} onChange={setCategory} ariaLabel="Filter knowledge by category" />
      <Select class="resource-filter-select" value={subcategory} options={subcategoryOptions} onChange={setSubcategory} ariaLabel="Filter knowledge by subcategory" />
      <Select class="resource-filter-select" value={tag} options={tagOptions} onChange={setTag} ariaLabel="Filter knowledge by tag" />
      <Select class="resource-filter-select" value={pinned} options={pinnedOptions} onChange={setPinned} ariaLabel="Filter knowledge by pin state" />
    </ResourceListToolbar>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No entries match." onClearFilters={() => { setQuery(""); setProjectId("all"); setCategory("all"); setSubcategory("all"); setTag("all"); setPinned("all"); setSurface("artifacts"); setSort("pinned_first"); }} />
    ) : (
      <EmptyState
        title="No entries yet"
        body="Save reusable context here so agents and teammates can find it later."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/library/knowledge/new"); }}>New entry</Button>}
      />
    )
  ) : (
    <ResourceList>
      {groups.map((group) => (
        <ResourceGroup key={group.key} group={group}>
          {group.items.map((e) => {
            return (
              <PaneRow
                key={e.slug}
                href={`#/library/knowledge/${encodeURIComponent(e.slug)}`}
                active={e.slug === selectedSlug}
                class="knowledge-pane-row"
                onClick={(event) => {
                  event?.preventDefault?.();
                  navigateHash(`#/library/knowledge/${encodeURIComponent(e.slug)}`);
                }}
                leading={(
                  <span class={`knowledge-row-leading ${e.pinned ? "pinned" : ""}`.trim()}>
                    <Icon name={e.pinned ? "pin" : "book"} size={12} />
                  </span>
                )}
                title={e.title}
                sub={(
                  <ResourceRowTags>
                    {e.project?.slug && <ResourceRowId>{e.project.slug}</ResourceRowId>}
                    {e.auto_promoted && <ResourceRowChip tone="info" icon="upload">run output</ResourceRowChip>}
                    {e.category && <ResourceRowChip tone="info" icon="book">{e.category}</ResourceRowChip>}
                    {e.subcategory && <ResourceRowChip tone="neutral">{e.subcategory}</ResourceRowChip>}
                    {e.pinned && <ResourceRowChip tone="accent" icon="pin">pinned</ResourceRowChip>}
                    {e.related_slugs?.length ? <ResourceRowChip tone="neutral" icon="link">{e.related_slugs.length} related</ResourceRowChip> : null}
                    <ResourceRowId>{e.slug}</ResourceRowId>
                  </ResourceRowTags>
                )}
                trailing={(
                  <span class="pane-row-summary pane-row-summary-metrics">
                    <span>{formatKnowledgeAge(e.updated_at)}</span>
                  </span>
                )}
              />
            );
          })}
        </ResourceGroup>
      ))}
    </ResourceList>
  );

  const isEditing = selectedSlug === "new" || mode === "edit";
  const detail = selectedSlug ? (
    isEditing ? (
      <KbEdit
        key={`${selectedSlug}:${mode || "create"}`}
        slug={selectedSlug}
        onSaved={() => { reload(); }}
        onDeleted={() => { reload(); window.location.hash = "#/library/knowledge"; }}
        prefill={isEditing && selectedSlug === "new" ? routeQuery : null}
        tagSuggestions={tagSuggestions}
      />
    ) : (
      <KbDetail key={selectedSlug} slug={selectedSlug} />
    )
  ) : (
      <div class="pane-empty">
        <Icon name="book" size={28} />
        <h3>Select an entry</h3>
        <p>Open an entry to read, edit, or see where it is used.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/library/knowledge/new"); }}>New entry</Button>
      </div>
  );

  return (
    <PaneLayout
      listHeader={listHeader}
      listBody={listBody}
      detail={detail}
      hasSelection={!!selectedSlug}
      detailOwnsMobileBack={!!selectedSlug}
      listFirst
      fullDetail={!!selectedSlug}
      class="resource-list-layout"
      onBack={() => navigateHash("#/library/knowledge")}
      backLabel="All entries"
    />
  );
}
