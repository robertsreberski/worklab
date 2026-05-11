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

const routeLoaders = {
  designSystem: () => import("./routes/DesignSystem.jsx"),
  goals: () => import("./routes/Goals.jsx"),
  library: () => import("./routes/Library.jsx"),
  projects: () => import("./routes/Projects.jsx"),
  runs: () => import("./routes/Runs.jsx"),
  settings: () => import("./routes/Settings.jsx"),
  taskDetail: () => import("./routes/TaskDetail.jsx"),
  taskEdit: () => import("./routes/TaskEdit.jsx"),
};

const DesignSystem = lazyNamed(routeLoaders.designSystem, "DesignSystem");
const Goals = lazyNamed(routeLoaders.goals, "Goals");
const Library = lazyNamed(routeLoaders.library, "Library");
const Projects = lazyNamed(routeLoaders.projects, "Projects");
const Runs = lazyNamed(routeLoaders.runs, "Runs");
const Settings = lazyNamed(routeLoaders.settings, "Settings");
const TaskDetail = lazyNamed(routeLoaders.taskDetail, "TaskDetail");
const TaskEdit = lazyNamed(routeLoaders.taskEdit, "TaskEdit");

function preloadSecondaryRoutes() {
  for (const loader of Object.values(routeLoaders)) {
    loader().catch(() => {});
  }
}

function scheduleIdlePreload(callback) {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 2500 });
    return () => window.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 750);
  return () => window.clearTimeout(handle);
}

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

  useEffect(() => scheduleIdlePreload(preloadSecondaryRoutes), []);

  // Global keyboard shortcuts now live in AppShell via useGlobalShortcuts.

  let body;
  if (route === "tasks") {
    if (rest[0] === "new") body = <TaskEdit mode="create" query={query} />;
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
