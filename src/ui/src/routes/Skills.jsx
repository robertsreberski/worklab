// §6.6 Skills — pane layout.
import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusDot } from "../components/primitives/StatusDot.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { SkillEdit } from "./SkillEdit.jsx";
import { skillDisplayName } from "../lib/display.js";
import { navigateHash } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { pushToast } from "../lib/toast.js";

function isZipFile(file) {
  return /\.zip$/i.test(file?.name || "") || /zip/i.test(file?.type || "");
}

function hasFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

export function Skills({ selectedName = null }) {
  const [skills, setSkills] = useState([]);
  const [query, setQuery] = useState("");
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
      if (lastImported) navigateHash(`#/skills/${lastImported}`);
    } finally {
      setImporting(false);
    }
  }, [reload]);

  useEffect(() => { reload(); }, [reload]);
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => (
      s.name?.toLowerCase().includes(q) ||
      s.display_name?.toLowerCase().includes(q) ||
      s.trigger?.toLowerCase().includes(q)
    ));
  }, [skills, query]);

  const listHeader = (
    <>
      <SearchField value={query} onInput={(e) => setQuery(e.target.value)} placeholder="Search skills…" inputRef={searchRef} />
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
      <Button variant="primary" size="sm" iconLeft={<Icon name="plus" size={12} />} onClick={() => { navigateHash("#/skills/new"); }}>
        New skill
      </Button>
    </>
  );

  const listBody = filtered.length === 0 ? (
    query ? (
      <EmptyStateFiltered body="No skills match." onClearFilters={() => setQuery("")} />
    ) : (
      <EmptyState
        title="No skills yet"
        body="Skills are reusable playbooks agents apply when their trigger matches."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/skills/new"); }}>New skill</Button>}
      />
    )
  ) : (
    filtered.map((s) => {
      const always = s.priority === "always";
      return (
        <PaneRow
          key={s.name}
          href={`#/skills/${s.name}`}
          active={s.name === selectedName}
          class="skill-pane-row"
          onClick={(event) => {
            event?.preventDefault?.();
            navigateHash(`#/skills/${s.name}`);
          }}
          leading={<StatusDot status={s.enabled !== false ? "enabled" : "disabled"} size={8} />}
          title={skillDisplayName(s)}
          sub={(
            <span class="pane-row-subline">
              <span>{s.trigger || "No trigger defined"}</span>
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
    })
  );

  const detail = selectedName ? (
    <SkillEdit
      key={selectedName}
      name={selectedName}
      onSaved={(name) => { reload(); if (selectedName === "new") window.location.hash = `#/skills/${name}`; }}
      onDeleted={() => { reload(); window.location.hash = "#/skills"; }}
    />
  ) : (
      <div class="pane-empty">
        <Icon name="sparkles" size={28} />
        <h3>Select a skill</h3>
        <p>Skills are reusable playbooks agents apply when their trigger matches.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/skills/new"); }}>New skill</Button>
      </div>
  );

  return (
    <AppShell route="skills" title="Skills">
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
          onBack={() => navigateHash("#/skills")}
          backLabel="All skills"
        />
      </div>
    </AppShell>
  );
}
