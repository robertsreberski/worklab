import { AppShell } from "../../components/AppShell.jsx";
import { Tabs } from "../../components/primitives/Tabs.jsx";
import { Icon } from "../../components/Icon.jsx";
import { PageHeader, PanelGrid } from "../../components/layout/index.js";
import { navigateHash } from "../../lib/navigation.js";
import { SettingPanel } from "./components.jsx";

export const SETTINGS_TAB_ORDER = ["general", "providers", "about"];
const SETTINGS_TAB_LABELS = { general: "General", providers: "Providers", about: "About" };

function SettingsTabs({ activeTab }) {
  return (
    <Tabs
      value={activeTab}
      onChange={(next) => navigateHash(next === "general" ? "#/settings" : `#/settings/${next}`)}
      tabs={SETTINGS_TAB_ORDER.map((id) => ({ value: id, label: SETTINGS_TAB_LABELS[id] }))}
      ariaLabel="Settings tabs"
      class="settings-tabs tabs-pills"
    />
  );
}

export function SettingsRouteShell({
  activeTab,
  title,
  description,
  actions = null,
  mobileActionDock = null,
  compact = false,
  class: className = "",
  children,
}) {
  const routeClass = [
    "settings-page",
    "settings-route-shell",
    compact ? "settings-route-compact" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <AppShell route="settings" mobileActionDock={mobileActionDock}>
      <div class={routeClass}>
        <PageHeader
          kicker="Settings"
          title={title}
          description={description}
          actions={actions}
          tabs={<SettingsTabs activeTab={activeTab} />}
        />
        <div class="settings-route-content">
          {children}
        </div>
      </div>
    </AppShell>
  );
}

export function AboutTab() {
  return (
    <div class="settings-about">
      <section class="settings-about-hero" aria-labelledby="settings-about-title">
        <div class="settings-about-hero-copy">
          <span class="form-section-kicker">Local command center</span>
          <h2 id="settings-about-title">Worklab</h2>
          <p>
            A private workbench for planning, running, and reviewing agent work
            against local projects and tools.
          </p>
          <div class="settings-about-stat-grid">
            <div class="settings-about-stat">
              <Icon name="lock" size={15} />
              <span>Local runtime</span>
            </div>
            <div class="settings-about-stat">
              <Icon name="terminal" size={15} />
              <span>Full tool visibility</span>
            </div>
            <div class="settings-about-stat">
              <Icon name="book" size={15} />
              <span>Project memory</span>
            </div>
          </div>
        </div>
        <figure class="settings-about-visual">
          <img src="/about/worklab-about-hero.png" alt="" loading="lazy" />
        </figure>
      </section>
      <PanelGrid class="settings-about-grid">
        <SettingPanel icon="sparkles" title="Operating model" meta="Single-user orchestration">
          <p>
            Runs, providers, agents, projects, memory, and MCP tools stay visible
            from one local control surface.
          </p>
        </SettingPanel>
        <SettingPanel icon="clock" title="Runtime posture" meta="Observable by default">
          <p>
            Worklab favors explicit state, live logs, saved artifacts, and
            recoverable long-running work over hidden background automation.
          </p>
        </SettingPanel>
        <SettingPanel icon="keyboard" title="Shortcuts" meta="Fast local controls">
          <div class="settings-shortcut-list">
            <span><kbd>⌘\</kbd> opens the assistant dock.</span>
            <span><kbd>?</kbd> opens keyboard shortcuts.</span>
            <span><kbd>N</kbd> creates a new task.</span>
          </div>
        </SettingPanel>
      </PanelGrid>
    </div>
  );
}
