import { lazy, Suspense } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { LoadingState } from "./components/LoadingState.jsx";
import { Commander } from "./routes/Commander.jsx";
import {
  consumeAllowedHash,
  getNavigationGuard,
  isAppRouteHash,
  navigateHash,
  normalizeHash,
  parseHashRoute,
} from "./lib/navigation.js";

function lazyNamed(loader, exportName) {
  return lazy(() => loader().then((module) => ({ default: module[exportName] })));
}

const DesignSystem = lazyNamed(() => import("./routes/DesignSystem.jsx"), "DesignSystem");
const Goals = lazyNamed(() => import("./routes/Goals.jsx"), "Goals");
const Library = lazyNamed(() => import("./routes/Library.jsx"), "Library");
const Projects = lazyNamed(() => import("./routes/Projects.jsx"), "Projects");
const Runs = lazyNamed(() => import("./routes/Runs.jsx"), "Runs");
const Settings = lazyNamed(() => import("./routes/Settings.jsx"), "Settings");
const TaskDetail = lazyNamed(() => import("./routes/TaskDetail.jsx"), "TaskDetail");
const TaskEdit = lazyNamed(() => import("./routes/TaskEdit.jsx"), "TaskEdit");

function RouteFallback() {
  return <LoadingState caption="Loading route..." />;
}

export function App() {
  const [{ route, rest, query }, setRoute] = useState(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    let currentHash = isAppRouteHash(window.location.hash) ? normalizeHash(window.location.hash) : "#/tasks";
    if (window.location.hash !== currentHash) {
      window.history.replaceState(null, "", currentHash);
    }

    const handler = () => {
      if (!isAppRouteHash(window.location.hash)) return;
      const nextHash = normalizeHash(window.location.hash);
      if (consumeAllowedHash(nextHash)) {
        currentHash = nextHash;
        setRoute(parseHashRoute(nextHash));
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
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
      currentHash = nextHash;
      setRoute(parseHashRoute(nextHash));
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
  } else if (route === "library") {
    body = <Library tab={rest[0] || "agents"} rest={rest.slice(1)} query={query} />;
  } else if (route === "runs") {
    body = <Runs />;
  } else if (route === "settings") {
    body = <Settings tab={rest[0] || "general"} rest={rest.slice(1)} />;
  } else if (route === "design-system") {
    body = <DesignSystem />;
  } else if (route === "automations") {
    body = <Commander />;
  } else {
    body = <Commander />;
  }

  return <Suspense fallback={<RouteFallback />}>{body}</Suspense>;
}
