import { lazy, Suspense } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { LoadingState } from "./components/LoadingState.jsx";
import { Commander } from "./routes/Commander.jsx";
import { consumeAllowedHash, getNavigationGuard, navigateHash, normalizeHash } from "./lib/navigation.js";

function lazyNamed(loader, exportName) {
  return lazy(() => loader().then((module) => ({ default: module[exportName] })));
}

const Activity = lazyNamed(() => import("./routes/Activity.jsx"), "Activity");
const Agents = lazyNamed(() => import("./routes/Agents.jsx"), "Agents");
const DesignSystem = lazyNamed(() => import("./routes/DesignSystem.jsx"), "DesignSystem");
const Goals = lazyNamed(() => import("./routes/Goals.jsx"), "Goals");
const Knowledge = lazyNamed(() => import("./routes/Knowledge.jsx"), "Knowledge");
const Projects = lazyNamed(() => import("./routes/Projects.jsx"), "Projects");
const Providers = lazyNamed(() => import("./routes/Providers.jsx"), "Providers");
const Settings = lazyNamed(() => import("./routes/Settings.jsx"), "Settings");
const Skills = lazyNamed(() => import("./routes/Skills.jsx"), "Skills");
const TaskDetail = lazyNamed(() => import("./routes/TaskDetail.jsx"), "TaskDetail");
const TaskEdit = lazyNamed(() => import("./routes/TaskEdit.jsx"), "TaskEdit");
const Teams = lazyNamed(() => import("./routes/Teams.jsx"), "Teams");

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  const queryIndex = h.indexOf("?");
  const pathPart = queryIndex === -1 ? h : h.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? "" : h.slice(queryIndex + 1);
  const segments = pathPart.split("/").filter(Boolean);
  const route = segments[0] || "tasks";
  const rest = segments.slice(1);
  const query = {};
  for (const [key, value] of new URLSearchParams(queryPart)) {
    query[key] = value;
  }
  return { route, rest, query };
}

function RouteFallback() {
  return <LoadingState caption="Loading route..." />;
}

export function App() {
  const [{ route, rest, query }, setRoute] = useState(parseHash());

  useEffect(() => {
    let currentHash = normalizeHash(window.location.hash);

    const handler = () => {
      const nextHash = normalizeHash(window.location.hash);
      if (consumeAllowedHash(nextHash)) {
        currentHash = nextHash;
        setRoute(parseHash());
        return;
      }
      const guard = getNavigationGuard();
      if (guard?.isDirty?.() && nextHash !== currentHash) {
        guard.requestPrompt?.(nextHash);
        if (window.location.hash !== currentHash) {
          window.location.hash = currentHash;
        }
        return;
      }
      currentHash = nextHash;
      setRoute(parseHash());
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    if (route === "automations") navigateHash("#/tasks");
  }, [route]);

  // Global keyboard shortcuts now live in AppShell via useGlobalShortcuts.

  let body;
  if (route === "tasks") {
    if (rest[0] === "new") body = <TaskEdit mode="create" />;
    else if (rest[1] === "edit") body = <TaskEdit mode="edit" id={rest[0]} />;
    else if (rest[0]) body = <TaskDetail key={rest[0]} id={rest[0]} runParam={query.run || null} />;
    else body = <Commander query={query} />;
  } else if (route === "projects") {
    body = <Projects selectedId={rest[0] || null} mode={rest[1] || null} />;
  } else if (route === "goals") {
    body = <Goals selectedId={rest[0] || null} mode={rest[1] || null} />;
  } else if (route === "agents") {
    body = <Agents selectedName={rest[0] || null} />;
  } else if (route === "teams") {
    body = <Teams selectedId={rest[0] || null} mode={rest[1] || null} />;
  } else if (route === "skills") {
    body = <Skills selectedName={rest[0] || null} />;
  } else if (route === "knowledge") {
    body = <Knowledge selectedSlug={rest[0] || null} mode={rest[1] || null} query={query} />;
  } else if (route === "providers") {
    body = <Providers selectedId={rest[0] || null} />;
  } else if (route === "activity") {
    body = <Activity />;
  } else if (route === "settings") {
    body = <Settings />;
  } else if (route === "design-system") {
    body = <DesignSystem />;
  } else if (route === "automations") {
    body = <Commander />;
  } else {
    body = <Commander />;
  }

  return <Suspense fallback={<RouteFallback />}>{body}</Suspense>;
}
