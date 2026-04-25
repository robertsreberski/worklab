// §6.1 AppShell — persistent chrome: navigation rail + page header + main.
// Global rail chrome stays quiet (§9.4 item 8) — no ambient live counts.
// Skip-link at top for a11y.
// ? opens the keyboard-help drawer globally.

import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { ToastHost } from "./Toast.jsx";
import { KeyboardHelpDrawer } from "./KeyboardHelpDrawer.jsx";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { navigateHash } from "../lib/navigation.js";

export const ROUTES = [
  { id: "tasks",     label: "Tasks",     icon: "layout-list" },
  { id: "agents",    label: "Agents",    icon: "user" },
  { id: "skills",    label: "Skills",    icon: "sparkles" },
  { id: "knowledge", label: "Knowledge", icon: "book" },
  { id: "providers", label: "Providers", icon: "terminal" },
  { id: "activity",  label: "Activity",  icon: "clock" },
  { id: "schedules", label: "Schedules", icon: "calendar" },
  { id: "settings",  label: "Settings",  icon: "settings" },
];

export function AppShell({ route, title, headerMeta, headerActions, children }) {
  const [helpOpen, setHelpOpen] = useState(false);
  useGlobalShortcuts({
    "?": () => setHelpOpen(true),
    "N": () => { navigateHash("#/tasks/new"); },
    "Escape": () => { if (helpOpen) setHelpOpen(false); },
  });

  return (
    <div class="app">
      <a href="#main" class="skip-link">Skip to main content</a>
      <aside class="app-rail">
        <a
          class="brand-lockup"
          href="#/tasks"
          aria-label="Worklab"
          onClick={(event) => {
            event.preventDefault();
            navigateHash("#/tasks");
          }}
        >
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-copy">
            <strong>Worklab</strong>
            <span>Local agents</span>
          </span>
        </a>
        <nav class="app-nav" aria-label="Primary navigation">
          {ROUTES.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              class={route === item.id ? "active" : ""}
              aria-label={item.label}
              title={item.label}
              onClick={(event) => {
                event.preventDefault();
                navigateHash(`#/${item.id}`);
              }}
            >
              <Icon name={item.icon} size={14} class="nav-icon" />
              <span>{item.label}</span>
            </a>
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
      <div class="app-body">
        <header class="app-header">
          <div class="app-header-left">
            <h1 class="app-title">{title}</h1>
          </div>
          {headerMeta && <div class="app-header-meta">{headerMeta}</div>}
          {headerActions && <div class="toolbar">{headerActions}</div>}
        </header>
        <main id="main" class="app-main">{children}</main>
      </div>
      <ToastHost />
      <KeyboardHelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
