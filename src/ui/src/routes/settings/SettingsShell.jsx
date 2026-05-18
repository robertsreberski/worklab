import { AppShell } from "../../components/AppShell.jsx";
import { Tabs } from "../../components/primitives/Tabs.jsx";
import { Icon } from "../../components/Icon.jsx";
import { Banner } from "../../components/Banner.jsx";
import { Button } from "../../components/primitives/Button.jsx";
import { PageHeader, PanelGrid, Toolbar } from "../../components/layout/index.js";
import { navigateHash } from "../../lib/navigation.js";
import { pushToast } from "../../lib/toast.js";
import { FieldNote, SettingPanel } from "./components.jsx";
import {
  updateInstallCommand,
  updateInstallExplanation,
  updateStateForBadge,
  updateStateLabel,
  useUpdateStatus,
} from "./use-update-status.js";
import { updateInstallDescription, updateStatusMeta } from "./helpers.js";

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
  const {
    status: updateStatus,
    busy: updateBusy,
    applying: updateApplying,
    error: updateError,
    refresh: refreshUpdate,
    apply: applyUpdate,
  } = useUpdateStatus();

  const currentVersion = updateStatus?.package?.current_version || "";
  const badgeState = updateStateForBadge(updateStatus, { busy: updateBusy, error: updateError });
  const badgeLabel = updateStateLabel(updateStatus, { busy: updateBusy, error: updateError });
  const updateMeta = updateStatusMeta(updateStatus);

  async function onCheck() {
    try {
      await refreshUpdate({ refresh: true });
      pushToast("Update check refreshed.", { variant: "success" });
    } catch (err) {
      pushToast(`Update check failed: ${err.message}`, { variant: "error" });
    }
  }

  async function onApply() {
    try {
      await applyUpdate();
      pushToast("Update queued. Worklab will restart.", { variant: "success" });
    } catch (err) {
      pushToast(`Update failed: ${err.message}`, { variant: "error" });
    }
  }

  return (
    <div class="settings-about">
      <section class="settings-about-hero" aria-labelledby="settings-about-title">
        <div class="settings-about-hero-copy">
          <span class="form-section-kicker">Local command center</span>
          <h2 id="settings-about-title">Worklab</h2>
          <div class="settings-about-version">
            <span class="settings-about-version-num">{currentVersion ? `v${currentVersion}` : "—"}</span>
            <span class="settings-about-version-status" data-state={badgeState}>{badgeLabel}</span>
          </div>
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
        <SettingPanel icon="download" title="App updates" meta={`v${updateStatus?.package?.current_version || "—"}`} status={updateMeta.status} statusLabel={updateMeta.label}>
          <PanelGrid class="settings-note-grid">
            <FieldNote label="Current" value={updateStatus?.package?.current_version} />
            <FieldNote label="Latest" value={updateStatus?.package?.latest_version} />
            <FieldNote label="Install" value={updateInstallDescription(updateStatus?.install)} />
            <FieldNote label="Last check" value={updateStatus?.checked_at ? new Date(updateStatus.checked_at).toLocaleString() : "-"} />
            <FieldNote label="Job" value={updateStatus?.job?.status} />
            {updateError && <FieldNote label="Error" value={updateError} />}
          </PanelGrid>
          {updateStatus?.update_available && !updateStatus?.install?.supported && (
            <Banner
              variant="info"
              title={`Worklab ${updateStatus?.package?.latest_version || ""} is available`}
              detail={updateInstallExplanation(updateStatus.install)}
              class="settings-update-install-hint"
            >
              <code class="settings-update-install-cmd">{updateInstallCommand(updateStatus.install, updateStatus)}</code>
            </Banner>
          )}
          <Toolbar class="settings-update-actions">
            <Button size="sm" loading={updateBusy} iconLeft={<Icon name="refresh-cw" size={14} />} onClick={onCheck}>Check for updates</Button>
            {updateStatus?.update_available && updateStatus?.install?.supported && (
              <Button size="sm" variant="primary" loading={updateBusy || updateApplying} iconLeft={<Icon name="download" size={14} />} onClick={onApply}>
                {`Update to ${updateStatus?.package?.latest_version || ""}`}
              </Button>
            )}
          </Toolbar>
        </SettingPanel>
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
