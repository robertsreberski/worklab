// §6.6 Skills — pane layout.
import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../../lib/api.js";
import { Button } from "../../components/primitives/Button.jsx";
import { Select } from "../../components/primitives/Select.jsx";
import { Tabs } from "../../components/primitives/Tabs.jsx";
import { Icon } from "../../components/Icon.jsx";
import { StatusDot } from "../../components/primitives/StatusDot.jsx";
import { Chip } from "../../components/primitives/Chip.jsx";
import { PaneLayout } from "../../components/PaneLayout.jsx";
import { PaneRow } from "../../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../../components/EmptyState.jsx";
import { ResourceGroup, ResourceList, ResourceListToolbar } from "../../components/ResourceListToolbar.jsx";
import { ResourceRowChip, ResourceRowId, ResourceRowTags } from "../../components/ResourceRowMeta.jsx";
import { SkillEdit } from "../SkillEdit.jsx";
import { skillDisplayName } from "../../lib/display.js";
import { buildSkillResourceGroups, flattenResourceGroups } from "../../lib/resourceLists.js";
import { navigateHash } from "../../lib/navigation.js";
import { useGlobalShortcuts } from "../../lib/useGlobalShortcuts.js";
import { pushToast } from "../../lib/toast.js";
import { useAppResume } from "../../lib/pageVisibility.js";

function isZipFile(file) {
  return /\.zip$/i.test(file?.name || "") || /zip/i.test(file?.type || "");
}

function hasFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

export function SkillsTab({ selectedName = null, scopeTabs = null }) {
  const [skills, setSkills] = useState([]);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("enabled");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [usageFilter, setUsageFilter] = useState("all");
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const searchRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);

  const reload = useCallback(() => {
    return api.listSkills().then((r) => setSkills(r.skills || [])).catch(() => setSkills([]));
  }, []);

  const importZipFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    const zipFiles = files.filter(isZipFile);
    if (zipFiles.length === 0) {
      pushToast("Select a .zip skill package.", { variant: "error" });
      return;
    }
    const skipped = files.length - zipFiles.length;
    if (skipped > 0) {
      pushToast(`Skipped ${skipped} non-ZIP file${skipped === 1 ? "" : "s"}.`, { variant: "info" });
    }

    setImporting(true);
    let lastImported = null;
    try {
      for (const file of zipFiles) {
        try {
          const res = await api.importSkillZip(file);
          lastImported = res.skill?.name || lastImported;
          pushToast(`Imported ${res.skill?.name || file.name}`, { variant: "success" });
        } catch (err) {
          pushToast(`${file.name}: ${err.message}`, { variant: "error" });
        }
      }
      await reload();
      if (lastImported) navigateHash(`#/library/skills/${encodeURIComponent(lastImported)}`);
    } finally {
      setImporting(false);
    }
  }, [reload]);

  useEffect(() => { reload(); }, [reload]);
  useAppResume(reload);
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const groups = useMemo(() => buildSkillResourceGroups(skills, {
    query,
    state: stateFilter,
    priority: priorityFilter,
    usage: usageFilter,
  }), [priorityFilter, query, skills, stateFilter, usageFilter]);
  const filtered = useMemo(() => flattenResourceGroups(groups), [groups]);
  const hasFilter = query.trim() || stateFilter !== "enabled" || priorityFilter !== "all" || usageFilter !== "all";
  const stateTabs = useMemo(() => [
    { value: "enabled", label: "Enabled", count: skills.filter((skill) => skill.enabled !== false).length },
    { value: "disabled", label: "Disabled", count: skills.filter((skill) => skill.enabled === false).length },
    { value: "all", label: "All", count: skills.length },
  ], [skills]);
  const priorityOptions = [
    { value: "all", label: "All priorities" },
    { value: "always", label: "Always" },
    { value: "normal", label: "Normal" },
  ];
  const usageOptions = [
    { value: "all", label: "All usage" },
    { value: "used", label: "Used" },
    { value: "unused", label: "Unused" },
  ];

  const listHeader = (
    <ResourceListToolbar
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search skills…"
      searchAriaLabel="Search skills"
      searchRef={searchRef}
      countLabel={`${filtered.length} shown`}
      actionLabel="New skill"
      onAction={() => { navigateHash("#/library/skills/new"); }}
      configTitle="Skills configuration"
      activeConfigCount={[stateFilter !== "enabled", priorityFilter !== "all", usageFilter !== "all"].filter(Boolean).length}
      scopeTabs={scopeTabs}
    >
      <Tabs value={stateFilter} onChange={setStateFilter} tabs={stateTabs} ariaLabel="Filter skills by enabled state" class="tabs-pills" />
      <Select class="resource-filter-select" variant="menu" value={priorityFilter} onChange={setPriorityFilter} options={priorityOptions} ariaLabel="Filter skills by priority" />
      <Select class="resource-filter-select" variant="menu" value={usageFilter} onChange={setUsageFilter} options={usageOptions} ariaLabel="Filter skills by usage" />
      <input
        ref={fileInputRef}
        class="sr-only"
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        onChange={(event) => {
          importZipFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <Button
        variant="secondary"
        size="sm"
        loading={importing}
        iconLeft={<Icon name="upload" size={12} />}
        onClick={() => fileInputRef.current?.click()}
      >
        Import ZIP
      </Button>
    </ResourceListToolbar>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No skills match." onClearFilters={() => { setQuery(""); setStateFilter("enabled"); setPriorityFilter("all"); setUsageFilter("all"); }} />
    ) : (
      <EmptyState
        title="No skills yet"
        body="Skills are reusable playbooks agents apply when their trigger matches."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/library/skills/new"); }}>New skill</Button>}
      />
    )
  ) : (
    <ResourceList>
      {groups.map((group) => (
        <ResourceGroup key={group.key} group={group}>
          {group.items.map((s) => {
            const always = s.priority === "always";
            const enabled = s.enabled !== false;
            return (
              <PaneRow
                key={s.name}
                href={`#/library/skills/${encodeURIComponent(s.name)}`}
                active={s.name === selectedName}
                class="skill-pane-row"
                onClick={(event) => {
                  event?.preventDefault?.();
                  navigateHash(`#/library/skills/${encodeURIComponent(s.name)}`);
                }}
                leading={<StatusDot status={s.enabled !== false ? "enabled" : "disabled"} size={8} />}
                title={skillDisplayName(s)}
                sub={(
                  <span class="pane-row-substack">
                    <span class="pane-row-description">{s.trigger || "No trigger defined"}</span>
                    <ResourceRowTags>
                      <ResourceRowId>{s.name}</ResourceRowId>
                      {!enabled && <ResourceRowChip>disabled</ResourceRowChip>}
                    </ResourceRowTags>
                  </span>
                )}
                trailing={(
                  <span class="pane-row-summary pane-row-summary-metrics">
                    {always && <Chip variant="trigger">always</Chip>}
                    <span>used by {s.used_by_count || 0}</span>
                  </span>
                )}
              />
            );
          })}
        </ResourceGroup>
      ))}
    </ResourceList>
  );

  const detail = selectedName ? (
    <SkillEdit
      key={selectedName}
      name={selectedName}
      onSaved={(name) => { reload(); if (selectedName === "new") window.location.hash = `#/library/skills/${encodeURIComponent(name)}`; }}
      onDeleted={() => { reload(); window.location.hash = "#/library/skills"; }}
    />
  ) : (
      <div class="pane-empty">
        <Icon name="sparkles" size={28} />
        <h3>Select a skill</h3>
        <p>Skills are reusable playbooks agents apply when their trigger matches.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/library/skills/new"); }}>New skill</Button>
      </div>
  );

  return (
    <div
      class={`skill-import-surface ${dragActive ? "is-dragging" : ""}`.trim()}
      onDragEnter={(event) => {
        if (!hasFileDrag(event)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!hasFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (!hasFileDrag(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!hasFileDrag(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        importZipFiles(event.dataTransfer.files);
      }}
    >
      {dragActive && (
        <div class="skill-import-overlay" aria-hidden="true">
          <Icon name="upload" size={18} />
          <span>Drop ZIP files</span>
        </div>
      )}
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedName}
        detailOwnsMobileBack={!!selectedName}
        listFirst
        class="resource-list-layout"
        onBack={() => navigateHash("#/library/skills")}
        backLabel="All skills"
      />
    </div>
  );
}
