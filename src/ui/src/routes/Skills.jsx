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

export function Skills({ selectedName = null }) {
  const [skills, setSkills] = useState([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);

  const reload = useCallback(() => {
    api.listSkills().then((r) => setSkills(r.skills || [])).catch(() => setSkills([]));
  }, []);

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
          onClick={(event) => {
            event?.preventDefault?.();
            navigateHash(`#/skills/${s.name}`);
          }}
          leading={<StatusDot status={s.enabled !== false ? "enabled" : "disabled"} size={8} />}
          title={skillDisplayName(s)}
          sub={s.trigger || "No trigger defined"}
          trailing={(
            <span class="pane-row-summary">
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
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedName}
        onBack={() => navigateHash("#/skills")}
        backLabel="All skills"
      />
    </AppShell>
  );
}
