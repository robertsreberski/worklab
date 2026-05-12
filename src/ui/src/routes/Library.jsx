// §6.10 Library — merged route hosting Agents · Teams · Skills · Knowledge tabs.
// Per critique §06: tab order matches "doers → compositions → capabilities → knowledge".

import { AppShell } from "../components/AppShell.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { navigateHash } from "../lib/navigation.js";
import { AgentsTab } from "./library/AgentsTab.jsx";
import { TeamsTab } from "./library/TeamsTab.jsx";
import { SkillsTab } from "./library/SkillsTab.jsx";
import { KnowledgeTab } from "./library/KnowledgeTab.jsx";

const TAB_ORDER = ["agents", "teams", "skills", "knowledge"];
const TAB_LABELS = {
  agents: "Agents",
  teams: "Teams",
  skills: "Skills",
  knowledge: "Knowledge",
};

export function Library({ tab = "agents", rest = [], query = {} }) {
  const activeTab = TAB_ORDER.includes(tab) ? tab : "agents";
  const [item, mode] = rest;
  const tabs = TAB_ORDER.map((id) => ({ value: id, label: TAB_LABELS[id] }));
  const routeTabs = (
    <Tabs
      value={activeTab}
      onChange={(next) => navigateHash(`#/library/${next}`)}
      tabs={tabs}
      ariaLabel="Library tabs"
      class="library-tabs tabs-pills"
    />
  );

  let body;
  if (activeTab === "agents") {
    body = <AgentsTab selectedName={item || null} />;
  } else if (activeTab === "teams") {
    body = <TeamsTab selectedId={item || null} mode={mode || null} />;
  } else if (activeTab === "skills") {
    body = <SkillsTab selectedName={item || null} />;
  } else {
    body = <KnowledgeTab selectedSlug={item || null} mode={mode || null} query={query} />;
  }

  return (
    <AppShell route="library">
      <div class="library-page resource-tab-page">
        <div class="library-route-tabs">{routeTabs}</div>
        <div class="library-tab-body">{body}</div>
      </div>
    </AppShell>
  );
}
