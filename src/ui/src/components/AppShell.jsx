// §6.1 AppShell — persistent chrome: navigation rail + main.
// Global rail chrome stays quiet (§9.4 item 8) — no ambient live counts.
// Skip-link at top for a11y.
// ? opens the keyboard-help drawer globally.

import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { Icon } from "./Icon.jsx";
import { ToastHost } from "./Toast.jsx";
import { Banner } from "./Banner.jsx";
import { KeyboardHelpDrawer } from "./KeyboardHelpDrawer.jsx";
import { AssistantDock } from "./AssistantDock.jsx";
import { Button } from "./primitives/Button.jsx";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { useSSE } from "../lib/useSSE.js";
import { pushToast } from "../lib/toast.js";
import { navigateHash } from "../lib/navigation.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { ensureNotificationServiceWorker, maybeShowRunNotification, runNotificationRoute } from "../lib/browserNotifications.js";
import {
  ASSISTANT_WIDTH_MIN,
  ASSISTANT_WIDTH_STORAGE_KEY,
  assistantInitialWidth,
  assistantMaxWidthForViewport,
  clampAssistantWidth,
} from "../lib/assistantLayout.js";

export const ROUTE_GROUPS = [
  {
    label: "Work",
    routes: [
      { id: "tasks", label: "Tasks", icon: "layout-list", href: "#/tasks" },
      { id: "agents", label: "Agents", icon: "user", href: "#/library/agents" },
      { id: "knowledge", label: "Knowledge", icon: "book", href: "#/library/knowledge" },
    ],
  },
  {
    label: "Library",
    routes: [
      { id: "projects", label: "Projects", icon: "folder", href: "#/projects" },
      { id: "teams", label: "Teams", icon: "users", href: "#/library/teams" },
      { id: "skills", label: "Skills", icon: "sparkles", href: "#/library/skills" },
    ],
  },
  {
    label: "System",
    routes: [
      { id: "goals", label: "Goals", icon: "target", href: "#/goals" },
      { id: "runs", label: "Runs", icon: "clock", href: "#/runs" },
      { id: "settings", label: "Settings", icon: "settings", href: "#/settings" },
    ],
  },
];
export const ROUTES = ROUTE_GROUPS.flatMap((group) => group.routes);

const AppChromeContext = createContext(null);
export const AppShellEmbedContext = createContext(false);

const TABBAR_ROUTES = [
  { id: "tasks", label: "Tasks", icon: "layout-list", href: "#/tasks" },
  { id: "agents", label: "Agents", icon: "user", href: "#/library/agents" },
  { id: "projects", label: "Projects", icon: "folder", href: "#/projects" },
  { id: "knowledge", label: "Knowledge", icon: "book", href: "#/library/knowledge" },
];
const MORE_ROUTE_IDS = ["teams", "skills", "goals", "runs", "settings"];
const ROUTE_BY_ID = Object.fromEntries(ROUTES.map((route) => [route.id, route]));
const MORE_ROUTES = MORE_ROUTE_IDS
  .map((id) => ROUTE_BY_ID[id])
  .filter(Boolean)
  .map((route) => ({ ...route, href: route.href || `#/${route.id}` }));
const EMPTY_SECTIONS = [];
const ASSISTANT_PREF_KEY = "worklab.assistantDockOpen";
const UPDATE_DISMISS_KEY = "worklab.updateBannerDismissedVersion";

function currentHash() {
  return typeof window === "undefined" ? "" : window.location.hash || "";
}

function routeHref(item) {
  return item.href || `#/${item.id}`;
}

function routeIsActive(item, route) {
  const href = routeHref(item);
  const hash = currentHash();
  if (hash === href || hash.startsWith(`${href}/`) || hash.startsWith(`${href}?`)) return true;
  if (!hash && route === item.id) return true;
  if (item.id === "agents" && route === "library" && hash === "#/library") return true;
  if (item.id === "settings") return route === "settings" || hash.startsWith("#/settings");
  return route === item.id;
}

function assistantInitialOpen() {
  // Critique §08: assistant is ambient. Hidden by default; ⌘\ summons.
  // Respect the user's stored preference if they've opened it explicitly.
  if (typeof window === "undefined") return false;
  const stored = window.localStorage?.getItem?.(ASSISTANT_PREF_KEY);
  if (stored === "open") return true;
  return false;
}

function dismissedUpdateVersion() {
  if (typeof window === "undefined") return "";
  return window.localStorage?.getItem?.(UPDATE_DISMISS_KEY) || "";
}

function latestUpdateVersion(update) {
  return update?.package?.latest_version || "";
}

function shouldShowUpdateBanner(update, dismissedVersion) {
  const latest = latestUpdateVersion(update);
  return !!(update?.update_available && update?.install?.supported && latest && dismissedVersion !== latest);
}

function UpdateBanner({ update, dismissedVersion, applying, onApply, onDismiss }) {
  if (!shouldShowUpdateBanner(update, dismissedVersion)) return null;
  const current = update?.package?.current_version || "-";
  const latest = latestUpdateVersion(update);
  return (
    <div class="app-update-banner-wrap">
      <Banner
        variant="info"
        title="Worklab update available"
        detail={`Version ${latest} is available. Current version is ${current}.`}
        class="app-update-banner"
        actions={(
          <Button
            size="sm"
            variant="primary"
            loading={applying}
            iconLeft={<Icon name="download" size={14} />}
            onClick={onApply}
          >
            Update and restart
          </Button>
        )}
        onDismiss={onDismiss}
      />
    </div>
  );
}

export function useAppChrome(chrome, deps = []) {
  const context = useContext(AppChromeContext);
  useLayoutEffect(() => {
    if (!context) return undefined;
    context.setChrome(chrome || {});
    return () => context.setChrome({});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, ...deps]);
}

export function MobileTopbar({ title, backLabel = "Back", onBack, overflow = true }) {
  return (
    <div class="mobile-topbar">
      {onBack ? (
        <button type="button" class="mobile-topbar-back" onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          <span>{backLabel}</span>
        </button>
      ) : <span class="mobile-topbar-spacer" />}
      <span class="mobile-topbar-title">{title}</span>
      {overflow ? (
        <button
          type="button"
          class="mobile-topbar-overflow"
          aria-label="More"
          onClick={() => window.dispatchEvent(new CustomEvent("worklab:open-app-drawer"))}
        >
          <Icon name="more-horizontal" size={16} />
        </button>
      ) : <span class="mobile-topbar-spacer" />}
    </div>
  );
}

export function MobilePillRow({
  railLabel = "Details",
  railCount,
  sections,
  extra,
}) {
  return (
    <>
      {sections?.length > 0 && (
        <button type="button" class="section-jump-pill" onClick={() => window.dispatchEvent(new CustomEvent("worklab:open-section-sheet"))}>
          <span class="section-jump-glyph" aria-hidden="true">§</span>
          <span>Sections</span>
          <span class="count">{sections.length}</span>
        </button>
      )}
      {extra}
      <span class="mobile-pill-spacer" />
      <button type="button" class="rail-summary-pill" onClick={() => window.dispatchEvent(new CustomEvent("worklab:open-app-drawer"))}>
        <span class="glyph" aria-hidden="true" />
        <span>{railLabel}</span>
        {typeof railCount === "number" && <span class="count">{railCount}</span>}
      </button>
    </>
  );
}

function MobileMoreSheet({ open, route, onClose, onNavigate }) {
  const panelRef = useRef(null);
  useFocusTrap(panelRef, { active: open, onEscape: onClose });
  if (!open) return null;
  return (
    <div id="app-more-sheet" class={`app-more-sheet ${open ? "open" : ""}`.trim()} aria-hidden={!open}>
      <button type="button" class="app-more-sheet-scrim" aria-label="Close more navigation" onClick={onClose} />
      <div ref={panelRef} class="app-more-sheet-panel" role="dialog" aria-modal="true" aria-label="More navigation">
        <span class="app-more-sheet-grabber" aria-hidden="true" />
        <header class="app-more-sheet-head">
          <h2>More</h2>
          <button type="button" class="app-more-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <ul class="app-more-sheet-list">
          {MORE_ROUTES.map((item) => (
            <li key={item.id}>
              <a
                class={`app-more-sheet-link ${routeIsActive(item, route) ? "active" : ""}`.trim()}
                href={item.href}
                aria-current={routeIsActive(item, route) ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(item.href);
                }}
              >
                <span class="app-more-sheet-icon" aria-hidden="true">
                  <Icon name={item.icon} size={17} />
                </span>
                <span>{item.label}</span>
                <Icon name="chevron-right" size={15} class="app-more-sheet-arrow" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AppTabbar({ route }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_ROUTES.some((item) => routeIsActive(item, route));

  useEffect(() => {
    setMoreOpen(false);
  }, [route]);

  function navigateFromTabbar(hash) {
    navigateHash(hash);
    setMoreOpen(false);
  }

  return (
    <>
      <nav class="app-tabbar" aria-label="Mobile navigation">
        {TABBAR_ROUTES.map((item) => (
          <a
            key={item.id}
            class={routeIsActive(item, route) ? "active" : ""}
            href={item.href}
            aria-label={item.label}
            onClick={(event) => {
              event.preventDefault();
              navigateFromTabbar(item.href);
            }}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </a>
        ))}
        <button
          type="button"
          class={moreActive || moreOpen ? "active" : ""}
          aria-label="More"
          aria-haspopup="dialog"
          aria-expanded={moreOpen ? "true" : "false"}
          aria-controls="app-more-sheet"
          onClick={() => setMoreOpen((current) => !current)}
        >
          <Icon name="more-horizontal" size={18} />
          <span>More</span>
        </button>
      </nav>
      <MobileMoreSheet
        open={moreOpen}
        route={route}
        onClose={() => setMoreOpen(false)}
        onNavigate={navigateFromTabbar}
      />
    </>
  );
}

function RightDrawer({ open, onClose, kicker, title, children }) {
  if (!children || !open) return null;
  return (
    <div class={`app-right-drawer ${open ? "open" : ""}`.trim()} aria-hidden={!open}>
      <button type="button" class="app-right-drawer-scrim" aria-label="Close drawer" onClick={onClose} />
      <aside class="app-right-drawer-panel" role="dialog" aria-modal="true" aria-label={title || "Details"}>
        <header class="app-right-drawer-head">
          <div>
            {kicker && <span class="kicker">{kicker}</span>}
            <h2>{title || "Details"}</h2>
          </div>
          <button type="button" class="app-right-drawer-close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div class="app-right-drawer-body wl-scrollbar">{children}</div>
      </aside>
    </div>
  );
}

function SectionSheet({ open, onClose, sections = [] }) {
  if (!sections.length || !open) return null;
  return (
    <div class={`app-section-sheet ${open ? "open" : ""}`.trim()} aria-hidden={!open}>
      <button type="button" class="app-section-sheet-scrim" aria-label="Close sections" onClick={onClose} />
      <div class="app-section-sheet-panel" role="dialog" aria-modal="true" aria-label="Jump to section">
        <span class="app-section-sheet-grabber" aria-hidden="true" />
        <h2>Jump to section</h2>
        <ul>
          {sections.map((section) => (
            <li key={section.id || section.num || section.label}>
              <a href={`#${section.id}`} onClick={onClose}>
                {section.num && <span class="num">{section.num}</span>}
                <span>{section.label}</span>
                {section.meta && <span class="meta">{section.meta}</span>}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function AppShell({
  route,
  mobileActionDock,
  mobileTopbar,
  drawerContent,
  drawerTitle,
  drawerKicker,
  sections,
  children,
}) {
  const embedded = useContext(AppShellEmbedContext);
  const [helpOpen, setHelpOpen] = useState(false);
  const [registeredChrome, setRegisteredChrome] = useState({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sectionSheetOpen, setSectionSheetOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(assistantInitialOpen);
  const [assistantWidth, setAssistantWidth] = useState(assistantInitialWidth);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState(dismissedUpdateVersion);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const chromeContext = useMemo(() => ({ setChrome: setRegisteredChrome }), []);
  const activeDock = registeredChrome.mobileActionDock ?? mobileActionDock;
  const activeTopbar = registeredChrome.mobileTopbar ?? mobileTopbar;
  const activeDrawerContent = registeredChrome.drawerContent ?? drawerContent;
  const activeDrawerTitle = registeredChrome.drawerTitle ?? drawerTitle;
  const activeDrawerKicker = registeredChrome.drawerKicker ?? drawerKicker;
  const activeSections = registeredChrome.sections ?? sections ?? EMPTY_SECTIONS;

  useEffect(() => {
    const openDrawer = () => setDrawerOpen(true);
    const openSections = () => setSectionSheetOpen(true);
    window.addEventListener("worklab:open-app-drawer", openDrawer);
    window.addEventListener("worklab:open-section-sheet", openSections);
    return () => {
      window.removeEventListener("worklab:open-app-drawer", openDrawer);
      window.removeEventListener("worklab:open-section-sheet", openSections);
    };
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
    setSectionSheetOpen(false);
  }, [route]);

  useEffect(() => {
    if (embedded) return;
    window.localStorage?.setItem?.(ASSISTANT_PREF_KEY, assistantOpen ? "open" : "closed");
  }, [assistantOpen, embedded]);

  useEffect(() => {
    if (embedded) return;
    try {
      window.localStorage?.setItem?.(ASSISTANT_WIDTH_STORAGE_KEY, String(assistantWidth));
    } catch {}
  }, [assistantWidth, embedded]);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    setAssistantWidth((current) => clampAssistantWidth(current, viewportWidth));
  }, [viewportWidth]);

  const assistantMaxWidth = assistantMaxWidthForViewport(viewportWidth);

  function currentViewportWidth() {
    return typeof window === "undefined" ? viewportWidth : window.innerWidth;
  }

  function resizeAssistantFromClientX(clientX) {
    const currentWidth = currentViewportWidth();
    setAssistantWidth(clampAssistantWidth(currentWidth - clientX, currentWidth));
  }

  function resizeAssistantBy(delta) {
    const currentWidth = currentViewportWidth();
    setAssistantWidth((current) => clampAssistantWidth(current + delta, currentWidth));
  }

  function resizeAssistantTo(edge) {
    const currentWidth = currentViewportWidth();
    setAssistantWidth(edge === "max" ? assistantMaxWidthForViewport(currentWidth) : ASSISTANT_WIDTH_MIN);
  }

  useGlobalShortcuts({
    "?": () => { if (!embedded) setHelpOpen(true); },
    "N": () => { if (!embedded) navigateHash("#/tasks/new"); },
    // Critique §08: ⌘\ summons the ambient assistant. Esc collapses.
    "cmdbackslash": (event) => { if (!embedded) { event?.preventDefault?.(); setAssistantOpen((open) => !open); } },
    "Escape": () => {
      if (embedded) return;
      if (helpOpen) { setHelpOpen(false); return; }
      if (assistantOpen) setAssistantOpen(false);
    },
  });
  useEffect(() => {
    if (embedded) return;
    ensureNotificationServiceWorker().catch(() => {});
  }, [embedded]);

  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    api.getUpdate().then((response) => {
      if (!cancelled) setUpdateStatus(response.update || null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [embedded]);

  function dismissUpdateBanner() {
    const latest = latestUpdateVersion(updateStatus);
    if (!latest) return;
    setDismissedVersion(latest);
    try {
      window.localStorage?.setItem?.(UPDATE_DISMISS_KEY, latest);
    } catch {}
  }

  function pollForRestartedVersion(targetVersion, attempts = 0) {
    window.setTimeout(async () => {
      try {
        const health = await api.getHealth();
        if (health?.package?.version === targetVersion) {
          window.location.reload();
          return;
        }
      } catch {}
      if (attempts < 90) {
        pollForRestartedVersion(targetVersion, attempts + 1);
      } else {
        setUpdateApplying(false);
      }
    }, 1000);
  }

  async function applyUpdate() {
    const latest = latestUpdateVersion(updateStatus);
    if (!latest) return;
    setUpdateApplying(true);
    try {
      const response = await api.applyUpdate(latest);
      setUpdateStatus(response.update ? { ...response.update, job: response.apply } : updateStatus);
      pushToast("Update queued. Worklab will restart.", { variant: "success" });
      pollForRestartedVersion(latest);
    } catch (err) {
      setUpdateApplying(false);
      pushToast(`Update failed: ${err.message}`, { variant: "error" });
    }
  }

  useSSE("global", (event) => {
    if (embedded) return;
    if (event?.type === "update_apply_queued" && event.update) {
      setUpdateStatus(event.update);
    }
    maybeShowRunNotification(event, {
      onClick: (runEvent) => {
        const route = runNotificationRoute(runEvent);
        window.focus?.();
        if (route) navigateHash(route);
      },
    });
  });

  if (embedded) {
    return (
      <AppChromeContext.Provider value={chromeContext}>
        <div class="app-embedded-shell" data-route={route || ""}>
          {activeTopbar}
          <div class="app-embedded-main">{children}</div>
          {activeDock && (
            <div class="app-mobile-action-dock mobile-action-dock entity-edit-mobile-dock" aria-label="Page actions">
              {activeDock}
            </div>
          )}
          <RightDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            kicker={activeDrawerKicker}
            title={activeDrawerTitle}
          >
            {activeDrawerContent}
          </RightDrawer>
          <SectionSheet
            open={sectionSheetOpen}
            onClose={() => setSectionSheetOpen(false)}
            sections={activeSections}
          />
        </div>
      </AppChromeContext.Provider>
    );
  }

  return (
    <AppChromeContext.Provider value={chromeContext}>
      <div
        class={`app responsive ${activeTopbar ? "has-mobile-topbar" : ""} ${activeDock ? "has-mobile-action-dock has-dock" : ""} ${assistantOpen ? "assistant-open" : ""}`.trim()}
        data-route={route || ""}
        style={{ "--assistant-w": `${assistantWidth}px` }}
      >
        <a href="#main" class="skip-link">Skip to main content</a>
        <aside class="app-rail">
          <a
            class="brand-lockup brand"
            href="#/tasks"
            aria-label="Worklab"
            onClick={(event) => {
              event.preventDefault();
              navigateHash("#/tasks");
            }}
          >
            <span class="brand-mark" aria-hidden="true">
              <img src="/icons/worklab-icon-180.png" alt="" width="32" height="32" />
            </span>
            <span class="brand-copy">
              <strong>Worklab</strong>
              <span>Local agents</span>
            </span>
          </a>
          <nav class="app-nav rail-nav" aria-label="Primary navigation">
            {ROUTE_GROUPS.map((group) => (
              <div class="app-nav-group rail-group" key={group.label}>
                <div class="app-nav-group-label rail-group-label">{group.label}</div>
                {group.routes.map((item) => (
                  <a
                    key={item.id}
                    href={routeHref(item)}
                    class={routeIsActive(item, route) ? "active rail-link" : "rail-link"}
                    aria-label={item.label}
                    title={item.label}
                    onClick={(event) => {
                      event.preventDefault();
                      navigateHash(routeHref(item));
                    }}
                  >
                    <Icon name={item.icon} size={16} class="nav-icon icon" />
                    <span>{item.label}</span>
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div class="rail-footer">
            <button
              type="button"
              class="rail-status"
              onClick={() => setHelpOpen(true)}
              aria-label="Show keyboard shortcuts"
            >
              <Icon name="keyboard" size={12} />
              <span>Shortcuts · ?</span>
            </button>
          </div>
        </aside>
        <div class="app-body app-content">
          {activeTopbar}
          <UpdateBanner
            update={updateStatus}
            dismissedVersion={dismissedVersion}
            applying={updateApplying}
            onApply={applyUpdate}
            onDismiss={dismissUpdateBanner}
          />
          <main id="main" class="app-main scrollable-body wl-scrollbar">{children}</main>
          {activeDock && (
            <div class="app-mobile-action-dock mobile-action-dock entity-edit-mobile-dock" aria-label="Page actions">
              {activeDock}
            </div>
          )}
          <RightDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            kicker={activeDrawerKicker}
            title={activeDrawerTitle}
          >
            {activeDrawerContent}
          </RightDrawer>
          <SectionSheet
            open={sectionSheetOpen}
            onClose={() => setSectionSheetOpen(false)}
            sections={activeSections}
          />
        </div>
        <AssistantDock
          open={assistantOpen}
          onToggle={() => setAssistantOpen((current) => !current)}
          width={assistantWidth}
          minWidth={ASSISTANT_WIDTH_MIN}
          maxWidth={assistantMaxWidth}
          onResize={resizeAssistantFromClientX}
          onResizeBy={resizeAssistantBy}
          onResizeTo={resizeAssistantTo}
        />
        <AppTabbar route={route} />
        <ToastHost />
        <KeyboardHelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
      </div>
    </AppChromeContext.Provider>
  );
}
