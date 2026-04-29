import { useEffect, useState } from "preact/hooks";
import { Commander } from "./routes/Commander.jsx";
import { TaskDetail } from "./routes/TaskDetail.jsx";
import { TaskEdit } from "./routes/TaskEdit.jsx";
import { Settings } from "./routes/Settings.jsx";
import { Agents } from "./routes/Agents.jsx";
import { Skills } from "./routes/Skills.jsx";
import { Knowledge } from "./routes/Knowledge.jsx";
import { Providers } from "./routes/Providers.jsx";
import { Activity } from "./routes/Activity.jsx";
import { DesignSystem } from "./routes/DesignSystem.jsx";
import { consumeAllowedHash, getNavigationGuard, navigateHash, normalizeHash } from "./lib/navigation.js";

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart = ""] = h.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const route = segments[0] || "tasks";
  const rest = segments.slice(1);
  const query = {};
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { route, rest, query };
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
    else body = <Commander />;
  } else if (route === "agents") {
    body = <Agents selectedName={rest[0] || null} />;
  } else if (route === "skills") {
    body = <Skills selectedName={rest[0] || null} />;
  } else if (route === "knowledge") {
    body = <Knowledge selectedSlug={rest[0] || null} />;
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

  return <>{body}</>;
}
