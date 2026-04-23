import { Icon } from "./Icon.jsx";

export const ROUTES = [
  { id: "tasks", label: "Tasks", icon: "layout-list" },
  { id: "agents", label: "Agents", icon: "user" },
  { id: "skills", label: "Skills", icon: "sparkles" },
  { id: "knowledge", label: "Knowledge", icon: "book" },
  { id: "providers", label: "Providers", icon: "terminal" },
  { id: "activity", label: "Activity", icon: "clock" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function AppShell({ route, title, headerMeta, headerActions, children }) {
  return (
    <div class="app">
      <aside class="app-rail">
        <a class="brand-lockup" href="#/tasks" aria-label="Worklab">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-copy">
            <strong>Worklab</strong>
            <span>Command Center</span>
          </span>
        </a>
        <nav class="app-nav" aria-label="Primary navigation">
          {ROUTES.map((item) => (
            <a key={item.id} href={`#/${item.id}`} class={route === item.id ? "active" : ""}>
              <Icon name={item.icon} size={14} class="nav-icon" />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div class="rail-footer">
          <a class="rail-action" href="#/tasks/new">
            <Icon name="plus" size={13} />
            New task
          </a>
          <div class="rail-status">
            <span class="status-dot" style={{ "--dot-color": "var(--green)", "--dot-size": "7px" }} aria-hidden="true" />
            <span>localhost</span>
          </div>
        </div>
      </aside>
      <div class="app-body">
        <header class="app-header">
          <div class="app-header-left">
            <div class="eyebrow">Worklab</div>
            <h1 class="app-title">{title}</h1>
          </div>
          {headerMeta && <div class="app-header-meta">{headerMeta}</div>}
          {headerActions && <div class="toolbar">{headerActions}</div>}
        </header>
        <main class="app-main">{children}</main>
      </div>
    </div>
  );
}
