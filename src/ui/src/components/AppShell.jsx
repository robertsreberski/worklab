// §6.1 AppShell — persistent chrome: navigation rail + main.
// Global rail chrome stays quiet (§9.4 item 8) — no ambient live counts.
// Skip-link at top for a11y.
// ? opens the keyboard-help drawer globally.

import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { ToastHost } from "./Toast.jsx";
import { KeyboardHelpDrawer } from "./KeyboardHelpDrawer.jsx";
import { AssistantDock } from "./AssistantDock.jsx";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { useSSE } from "../lib/useSSE.js";
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
      { id: "tasks", label: "Tasks", icon: "layout-list" },
      { id: "activity", label: "Activity", icon: "clock" },
      { id: "projects", label: "Projects", icon: "folder" },
    ],
  },
  {
    label: "Library",
    routes: [
      { id: "teams", label: "Teams", icon: "users" },
      { id: "agents", label: "Agents", icon: "user" },
      { id: "skills", label: "Skills", icon: "sparkles" },
      { id: "knowledge", label: "Knowledge", icon: "book" },
    ],
  },
  {
    label: "System",
    routes: [
      { id: "providers", label: "Providers", icon: "terminal" },
      { id: "settings", label: "Settings", icon: "settings" },
    ],
  },
];
export const ROUTES = ROUTE_GROUPS.flatMap((group) => group.routes);

const AppChromeContext = createContext(null);

const TABBAR_ROUTES = [
  { id: "tasks", label: "Tasks", icon: "layout-list", href: "#/tasks" },
  { id: "activity", label: "Activity", icon: "clock", href: "#/activity" },
  { id: "projects", label: "Projects", icon: "folder", href: "#/projects" },
  { id: "agents", label: "Agents", icon: "user", href: "#/agents" },
];
const MORE_ROUTE_IDS = ["teams", "skills", "knowledge", "providers", "settings"];
const MORE_ROUTES = ROUTES
  .filter((route) => MORE_ROUTE_IDS.includes(route.id))
  .map((route) => ({ ...route, href: `#/${route.id}` }));
const EMPTY_SECTIONS = [];
const ASSISTANT_PREF_KEY = "worklab.assistantDockOpen";

function assistantInitialOpen() {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage?.getItem?.(ASSISTANT_PREF_KEY);
  if (stored === "open") return true;
  if (stored === "closed") return false;
  return !window.matchMedia?.("(max-width: 860px)")?.matches;
}

export function useAppChrome(chrome, deps = []) {
  const context = useContext(AppChromeContext);
  useEffect(() => {
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
                class={`app-more-sheet-link ${route === item.id ? "active" : ""}`.trim()}
                href={item.href}
                aria-current={route === item.id ? "page" : undefined}
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
  const moreActive = MORE_ROUTE_IDS.includes(route);

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
            class={route === item.id ? "active" : ""}
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [registeredChrome, setRegisteredChrome] = useState({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sectionSheetOpen, setSectionSheetOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(assistantInitialOpen);
  const [assistantWidth, setAssistantWidth] = useState(assistantInitialWidth);
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
    window.localStorage?.setItem?.(ASSISTANT_PREF_KEY, assistantOpen ? "open" : "closed");
  }, [assistantOpen]);

  useEffect(() => {
    try {
      window.localStorage?.setItem?.(ASSISTANT_WIDTH_STORAGE_KEY, String(assistantWidth));
    } catch {}
  }, [assistantWidth]);

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
    "?": () => setHelpOpen(true),
    "N": () => { navigateHash("#/tasks/new"); },
    "Escape": () => { if (helpOpen) setHelpOpen(false); },
  });
  useEffect(() => {
    ensureNotificationServiceWorker().catch(() => {});
  }, []);
  useSSE("global", (event) => {
    maybeShowRunNotification(event, {
      onClick: (runEvent) => {
        const route = runNotificationRoute(runEvent);
        window.focus?.();
        if (route) navigateHash(route);
      },
    });
  });

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
                    href={`#/${item.id}`}
                    class={route === item.id ? "active rail-link" : "rail-link"}
                    aria-label={item.label}
                    title={item.label}
                    onClick={(event) => {
                      event.preventDefault();
                      navigateHash(`#/${item.id}`);
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
