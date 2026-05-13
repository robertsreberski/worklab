import { lazy, Suspense } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { AppShellEmbedContext } from "./components/AppShell.jsx";
import { LoadingState } from "./components/LoadingState.jsx";
import { Modal } from "./components/Modal.jsx";
import { Button } from "./components/primitives/Button.jsx";
import { Commander } from "./routes/Commander.jsx";
import {
  consumeAllowedHash,
  getNavigationGuard,
  isAppRouteHash,
  navigateHash,
  normalizeHash,
  parseHashRoute,
  registerOverlayNavigationHandler,
  requestGuardedAction,
} from "./lib/navigation.js";
import { resourceOverlayNavigationFromHash, resourceOverlayTargetFromHref } from "./lib/resourceOverlay.js";

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

function ResourceOverlayBody({ target }) {
  if (target.route === "library") {
    return <Library tab={target.tab || "agents"} rest={target.rest} query={target.query} detailOnly />;
  }
  if (target.route === "projects") {
    return <Projects selectedId={target.rest[0] || null} mode={target.rest[1] || null} detailOnly />;
  }
  if (target.route === "goals") {
    return <Goals selectedId={target.rest[0] || null} mode={target.rest[1] || null} detailOnly />;
  }
  if (target.route === "tasks") {
    if (target.rest[1] === "edit") {
      return <TaskEdit mode="edit" id={target.rest[0]} />;
    }
    return <TaskDetail key={`${target.rest[0] || ""}:${target.query?.run || ""}`} id={target.rest[0]} runParam={target.query?.run || null} />;
  }
  if (target.route === "runs") {
    return <Runs />;
  }
  return <LoadingState caption="Resource unavailable." />;
}

function ResourceOverlay({ target, onClose, onOpenPage }) {
  const scrollRef = useRef(null);

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`${target.title} details`}
      size="lg"
      class="resource-overlay-modal"
      initialFocusRef={scrollRef}
      footer={(
        <>
          <Button variant="secondary" onClick={onOpenPage}>Open page</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      )}
    >
      <div
        ref={scrollRef}
        class="resource-overlay-scroll wl-scrollbar"
        tabIndex={0}
        aria-label={`${target.title} resource detail`}
      >
        <AppShellEmbedContext.Provider value>
          <Suspense fallback={<RouteFallback />}>
            <ResourceOverlayBody target={target} />
          </Suspense>
        </AppShellEmbedContext.Provider>
      </div>
    </Modal>
  );
}

export function App() {
  const [{ route, rest, query }, setRoute] = useState(() => parseHashRoute(window.location.hash));
  const [resourceOverlayTarget, setResourceOverlayTarget] = useState(null);
  const resourceOverlayOpenerRef = useRef(null);

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

  useEffect(() => {
    function onDocumentClick(event) {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const anchor = target?.closest?.("a.entity-badge[href]");
      if (!anchor || anchor.target === "_blank") return;
      const overlayTarget = resourceOverlayTargetFromHref(anchor.getAttribute("href"));
      if (!overlayTarget) return;
      event.preventDefault();
      event.stopPropagation();
      resourceOverlayOpenerRef.current = anchor;
      setResourceOverlayTarget(overlayTarget);
    }

    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, []);

  useEffect(() => {
    if (!resourceOverlayTarget) return undefined;
    return registerOverlayNavigationHandler((hash) => {
      const next = resourceOverlayNavigationFromHash(hash);
      if (next.action === "open") {
        setResourceOverlayTarget(next.target);
        return true;
      }
      if (next.action === "close") {
        setResourceOverlayTarget(null);
        return true;
      }
      return false;
    });
  }, [resourceOverlayTarget]);

  const closeResourceOverlay = useCallback(() => {
    requestGuardedAction(() => {
      const opener = resourceOverlayOpenerRef.current;
      setResourceOverlayTarget(null);
      window.setTimeout(() => opener?.focus?.(), 0);
    });
  }, []);

  const openResourceOverlayPage = useCallback(() => {
    const target = resourceOverlayTarget;
    if (!target?.href) return;
    requestGuardedAction(() => {
      setResourceOverlayTarget(null);
      navigateHash(target.href, { bypassOverlay: true });
    });
  }, [resourceOverlayTarget]);

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

  return (
    <Suspense fallback={<RouteFallback />}>
      {body}
      {resourceOverlayTarget && (
        <ResourceOverlay
          target={resourceOverlayTarget}
          onClose={closeResourceOverlay}
          onOpenPage={openResourceOverlayPage}
        />
      )}
    </Suspense>
  );
}
