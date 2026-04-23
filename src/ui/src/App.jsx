import { useEffect, useState } from "preact/hooks";
import { Kanban } from "./routes/Kanban.jsx";
import { TaskDetail } from "./routes/TaskDetail.jsx";
import { Settings } from "./routes/Settings.jsx";
import { Agents } from "./routes/Agents.jsx";
import { AgentEdit } from "./routes/AgentEdit.jsx";
import { Skills } from "./routes/Skills.jsx";
import { SkillEdit } from "./routes/SkillEdit.jsx";
import { Knowledge } from "./routes/Knowledge.jsx";
import { KbEdit } from "./routes/KbEdit.jsx";
import { Providers } from "./routes/Providers.jsx";
import { Activity } from "./routes/Activity.jsx";
import { ToastHost } from "./components/Toast.jsx";

const ROUTES = [
  { id: "tasks", label: "Tasks", summary: "Plan, run, and review agent work." },
  { id: "agents", label: "Agents", summary: "Configure executors, reviewers, tools, and memory." },
  { id: "skills", label: "Skills", summary: "Manage reusable agent playbooks." },
  { id: "knowledge", label: "Knowledge", summary: "Curate shared context for humans and agents." },
  { id: "providers", label: "Providers", summary: "Connect local, hosted, and custom model backends." },
  { id: "activity", label: "Activity", summary: "Audit recent runs, usage, and outcomes." },
  { id: "settings", label: "Settings", summary: "Tune runtime behavior and search defaults." },
];

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart = ""] = h.split("?");
  const [route, ...rest] = pathPart.split("/");
  const query = {};
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { route: route || "tasks", rest, query };
}

export function App() {
  const [{ route, rest, query }, setRoute] = useState(parseHash());

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  let body;
  if (route === "tasks" && rest[0]) body = <TaskDetail key={rest[0]} id={rest[0]} runParam={query.run || null} />;
  else if (route === "tasks") body = <Kanban />;
  else if (route === "agents" && rest[0]) body = <AgentEdit name={rest[0]} />;
  else if (route === "agents") body = <Agents />;
  else if (route === "skills" && rest[0]) body = <SkillEdit name={rest[0]} />;
  else if (route === "skills") body = <Skills />;
  else if (route === "knowledge" && rest[0]) body = <KbEdit key={rest[0]} slug={rest[0]} />;
  else if (route === "knowledge") body = <Knowledge />;
  else if (route === "providers") body = <Providers />;
  else if (route === "activity") body = <Activity />;
  else if (route === "settings") body = <Settings />;
  else body = <Kanban />;

  const activeRoute = ROUTES.find((item) => item.id === route) || ROUTES[0];
  const detailContext = rest[0] && rest[0] !== "new";
  const createContext = rest[0] === "new";

  return (
    <div class="app app-shell">
      <aside class="app-rail">
        <a class="brand-lockup" href="#/tasks" aria-label="Worklab tasks">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-copy">
            <strong>Worklab</strong>
            <span>Local agent ops</span>
          </span>
        </a>
        <nav class="topnav app-nav" aria-label="Primary navigation">
          {ROUTES.map((item) => (
            <a key={item.id} href={`#/${item.id}`} class={route === item.id ? "active" : ""}>
              <span class="nav-dot" aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div class="rail-status">
          <span class="status-dot status-dot-ok" aria-hidden="true" />
          <span>localhost</span>
        </div>
      </aside>
      <div class="app-body">
        <header class="app-header">
          <div>
            <div class="eyebrow">Workspace</div>
            <div class="app-title">{activeRoute.label}</div>
            <p>{createContext ? "Create a new record." : detailContext ? "Inspect and update the selected record." : activeRoute.summary}</p>
          </div>
        </header>
        <main class="app-main">{body}</main>
      </div>
      <ToastHost />
    </div>
  );
}
