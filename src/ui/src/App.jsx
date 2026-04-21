import { useEffect, useState } from "preact/hooks";
import { Kanban } from "./routes/Kanban.jsx";
import { TaskDetail } from "./routes/TaskDetail.jsx";
import { Settings } from "./routes/Settings.jsx";

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [route, ...rest] = h.split("/");
  return { route: route || "tasks", rest };
}

export function App() {
  const [{ route, rest }, setRoute] = useState(parseHash());

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  let body;
  if (route === "tasks" && rest[0]) body = <TaskDetail id={rest[0]} />;
  else if (route === "tasks") body = <Kanban />;
  else if (route === "settings") body = <Settings />;
  else body = <Kanban />;

  return (
    <div class="app">
      <nav class="topnav">
        <a href="#/tasks" class={route === "tasks" ? "active" : ""}>Tasks</a>
        <a href="#/settings" class={route === "settings" ? "active" : ""}>Settings</a>
      </nav>
      <main>{body}</main>
    </div>
  );
}
