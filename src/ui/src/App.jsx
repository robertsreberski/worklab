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
import { ToastHost } from "./components/Toast.jsx";

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

function goTo(path) {
  window.location.hash = path;
}

export function App() {
  const [{ route, rest, query }, setRoute] = useState(parseHash());

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      const target = e.target;
      const tag = target?.tagName?.toLowerCase?.() || "";
      const editable = target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
      if (editable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        goTo("#/tasks/new");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  } else {
    body = <Commander />;
  }

  return (
    <>
      {body}
      <ToastHost />
    </>
  );
}
