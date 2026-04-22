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
  else if (route === "agents" && rest[0]) body = <AgentEdit name={rest[0]} />;
  else if (route === "agents") body = <Agents />;
  else if (route === "skills" && rest[0]) body = <SkillEdit name={rest[0]} />;
  else if (route === "skills") body = <Skills />;
  else if (route === "knowledge" && rest[0]) body = <KbEdit slug={rest[0]} />;
  else if (route === "knowledge") body = <Knowledge />;
  else if (route === "providers") body = <Providers />;
  else if (route === "activity") body = <Activity />;
  else if (route === "settings") body = <Settings />;
  else body = <Kanban />;

  return (
    <div class="app">
      <nav class="topnav">
        <a href="#/tasks" class={route === "tasks" ? "active" : ""}>Tasks</a>
        <a href="#/agents" class={route === "agents" ? "active" : ""}>Agents</a>
        <a href="#/skills" class={route === "skills" ? "active" : ""}>Skills</a>
        <a href="#/knowledge" class={route === "knowledge" ? "active" : ""}>Knowledge</a>
        <a href="#/providers" class={route === "providers" ? "active" : ""}>Providers</a>
        <a href="#/activity" class={route === "activity" ? "active" : ""}>Activity</a>
        <a href="#/settings" class={route === "settings" ? "active" : ""}>Settings</a>
      </nav>
      <main>{body}</main>
    </div>
  );
}
