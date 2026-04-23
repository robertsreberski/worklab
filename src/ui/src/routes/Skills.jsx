import { useEffect, useState, useCallback, useMemo } from "preact/hooks";
import { api } from "../lib/api.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/SearchField.jsx";
import { Icon } from "../components/Icon.jsx";
import { SkillEdit } from "./SkillEdit.jsx";
import { skillDisplayName } from "../lib/display.js";

function SkillRow({ skill, active }) {
  const always = skill.priority === "always";
  return (
    <a
      href={`#/skills/${skill.name}`}
      class={`pane-row ${active ? "active" : ""}`}
    >
      <span
        class="status-dot"
        style={{
          "--dot-color": skill.enabled !== false ? "var(--green)" : "var(--muted-2)",
          "--dot-size": "8px",
        }}
        aria-hidden="true"
      />
      <div class="pane-row-main">
        <div class="pane-row-title">{skillDisplayName(skill)}</div>
        <div class="pane-row-sub">{skill.trigger || "No trigger defined"}</div>
      </div>
      <div class="pane-row-meta">
        {always && <span class="chip chip-accent">always</span>}
      </div>
    </a>
  );
}

export function Skills({ selectedName = null }) {
  const [skills, setSkills] = useState([]);
  const [query, setQuery] = useState("");

  const reload = useCallback(() => {
    api.listSkills().then((r) => setSkills(r.skills || [])).catch(() => setSkills([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => {
      return (
        s.name?.toLowerCase().includes(q) ||
        s.display_name?.toLowerCase().includes(q) ||
        s.trigger?.toLowerCase().includes(q)
      );
    });
  }, [skills, query]);

  const headerMeta = (
    <>
      <span>{skills.length} skills</span>
      <span class="dot">·</span>
      <span>{skills.filter((s) => s.enabled !== false).length} enabled</span>
    </>
  );

  return (
    <AppShell route="skills" title="Skills" headerMeta={headerMeta}>
      <div class="two-pane">
        <aside class="pane-list">
          <div class="pane-list-head">
            <SearchField
              value={query}
              onInput={(e) => setQuery(e.target.value)}
              placeholder="Search skills..."
            />
            <a href="#/skills/new" class="button primary small" style={{ justifyContent: "center" }}>
              <Icon name="plus" size={12} />
              New skill
            </a>
          </div>
          <div class="pane-list-body wl-hide-scrollbar">
            {filtered.length === 0 && (
              <div class="pane-empty">{query ? "No skills match." : "No skills yet."}</div>
            )}
            {filtered.map((s) => (
              <SkillRow key={s.name} skill={s} active={s.name === selectedName} />
            ))}
          </div>
        </aside>
        <section class="pane-detail">
          {selectedName ? (
            <SkillEdit
              key={selectedName}
              name={selectedName}
              onSaved={(name) => {
                reload();
                if (selectedName === "new") window.location.hash = `#/skills/${name}`;
              }}
              onDeleted={() => {
                reload();
                window.location.hash = "#/skills";
              }}
            />
          ) : (
            <div class="pane-empty">
              <Icon name="sparkles" size={28} />
              <h3>Select a skill</h3>
              <p>Skills are reusable playbooks agents apply when their trigger matches.</p>
              <a href="#/skills/new" class="button primary">
                <Icon name="plus" size={13} />
                New skill
              </a>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
