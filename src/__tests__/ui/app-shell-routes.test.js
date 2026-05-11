import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_GROUPS, ROUTES } from "../../ui/src/components/AppShell.jsx";

const appShellPath = resolve(import.meta.dirname, "../../ui/src/components/AppShell.jsx");
const assistantDockPath = resolve(import.meta.dirname, "../../ui/src/components/AssistantDock.jsx");
const entityChromeBridgePath = resolve(import.meta.dirname, "../../ui/src/components/EntityChromeBridge.jsx");
const appPath = resolve(import.meta.dirname, "../../ui/src/App.jsx");
const commanderPath = resolve(import.meta.dirname, "../../ui/src/routes/Commander.jsx");
const primitiveIndexPath = resolve(import.meta.dirname, "../../ui/src/components/primitives/index.js");
const lazyRouteModules = [
  "DesignSystem",
  "Goals",
  "Library",
  "Projects",
  "Runs",
  "Settings",
  "TaskDetail",
  "TaskEdit",
];

function moreRouteIds() {
  const source = readFileSync(appShellPath, "utf8");
  const match = source.match(/const MORE_ROUTE_IDS = \[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function tabbarRouteIds() {
  const source = readFileSync(appShellPath, "utf8");
  const match = source.match(/const TABBAR_ROUTES = \[([\s\S]*?)\];/);
  if (!match) return [];
  return [...match[1].matchAll(/id: "([^"]+)"/g)].map((item) => item[1]);
}

describe("app shell routes", () => {
  it("exposes the corrected Work, Library, and System IA", () => {
    const workGroup = ROUTE_GROUPS.find((group) => group.label === "Work");
    const libraryGroup = ROUTE_GROUPS.find((group) => group.label === "Library");
    const systemGroup = ROUTE_GROUPS.find((group) => group.label === "System");

    expect(workGroup?.routes.map((route) => route.id)).toEqual([
      "tasks",
      "agents",
      "knowledge",
    ]);
    expect(libraryGroup?.routes.map((route) => route.id)).toEqual([
      "projects",
      "teams",
      "skills",
    ]);
    expect(systemGroup?.routes.map((route) => route.id)).toEqual([
      "goals",
      "runs",
      "settings",
    ]);
    expect(ROUTES.find((route) => route.id === "agents")).toMatchObject({
      label: "Agents",
      icon: "user",
      href: "#/library/agents",
    });
    expect(ROUTES.find((route) => route.id === "knowledge")).toMatchObject({
      label: "Knowledge",
      icon: "book",
      href: "#/library/knowledge",
    });
    expect(ROUTES.find((route) => route.id === "projects")).toMatchObject({
      label: "Projects",
      icon: "folder",
      href: "#/projects",
    });
    expect(ROUTES.find((route) => route.id === "teams")).toMatchObject({
      label: "Teams",
      icon: "users",
      href: "#/library/teams",
    });
    expect(ROUTES.find((route) => route.id === "skills")).toMatchObject({
      label: "Skills",
      icon: "sparkles",
      href: "#/library/skills",
    });
    expect(ROUTES.find((route) => route.id === "settings")).toMatchObject({
      label: "Settings",
      icon: "settings",
    });
  });

  it("keeps Goals as a first-class System route", () => {
    const systemGroup = ROUTE_GROUPS.find((group) => group.label === "System");
    const systemIds = systemGroup?.routes.map((route) => route.id) || [];

    expect(systemIds).toContain("goals");
    expect(systemIds.indexOf("goals")).toBeLessThan(systemIds.indexOf("runs"));
    expect(ROUTES.find((route) => route.id === "goals")).toMatchObject({
      label: "Goals",
      icon: "target",
    });
  });

  it("keeps Work-first routes in the mobile tabbar", () => {
    expect(tabbarRouteIds()).toEqual(["tasks", "agents", "projects"]);
  });

  it("keeps Library and System routes in mobile More navigation", () => {
    const ids = moreRouteIds();

    expect(ids).toEqual(["teams", "skills", "knowledge", "goals", "runs", "settings"]);
  });

  it("keeps the ambient assistant launcher icon-only and owned by AssistantDock", () => {
    const appShell = readFileSync(appShellPath, "utf8");
    const assistantDock = readFileSync(assistantDockPath, "utf8");

    expect(appShell).not.toContain('class="assistant-launcher"');
    expect(assistantDock).toContain('class="assistant-launcher"');
    expect(assistantDock).not.toContain('class="assistant-pill"');
  });

  it("keeps the shortcuts affordance in the rail footer", () => {
    const source = readFileSync(appShellPath, "utf8");

    expect(source).toContain('class="rail-status"');
    expect(source).toContain("Shortcuts · ?");
  });

  it("keeps settings available from mobile More navigation", () => {
    const ids = moreRouteIds();

    expect(ids).toContain("settings");
  });

  it("does not ship prototype rail identity copy", () => {
    const source = readFileSync(appShellPath, "utf8");

    expect(source).not.toContain("kael");
    expect(source).not.toContain('aria-hidden="true">k</span>');
  });

  it("keeps secondary routes behind dynamic imports", () => {
    const source = readFileSync(appPath, "utf8");

    expect(source).toContain('import { Commander } from "./routes/Commander.jsx";');
    expect(source).toContain("Suspense");
    expect(source).toContain("preloadSecondaryRoutes");
    expect(source).toContain("requestIdleCallback");
    for (const routeModule of lazyRouteModules) {
      expect(source).not.toContain(`import { ${routeModule} } from "./routes/${routeModule}.jsx";`);
      expect(source).toContain(`import("./routes/${routeModule}.jsx")`);
    }
  });

  it("defers assistant hydration until the dock is opened", () => {
    const source = readFileSync(assistantDockPath, "utf8");

    expect(source).toContain("hasLoadedAssistantRef");
    expect(source).toContain("if (!open || hasLoadedAssistantRef.current) return");
    expect(source).not.toContain("useEffect(() => {\n    loadAssistant();\n  }, [])");
  });

  it("keeps the task detail route out of the eager commander chunk", () => {
    const source = readFileSync(commanderPath, "utf8");

    expect(source).not.toContain('from "./TaskDetail.jsx"');
    expect(source).toContain('from "./task-detail/summaryCache.js"');
  });

  it("exports StatusDot directly from its primitive module", () => {
    const source = readFileSync(primitiveIndexPath, "utf8");

    expect(source).toContain('export { StatusDot } from "./StatusDot.jsx";');
    expect(source).not.toContain('export { StatusPill, StatusDot, statusMeta } from "./StatusPill.jsx";');
  });

  it("shares entity chrome registration instead of duplicating route-local bridges", () => {
    expect(existsSync(entityChromeBridgePath)).toBe(true);
    const bridgeSource = readFileSync(entityChromeBridgePath, "utf8");
    expect(bridgeSource).toContain("useAppChrome");
    expect(bridgeSource).toContain("export function EntityChromeBridge");

    const entityRoutes = [
      { path: "AgentEdit.jsx", importPath: "../components/EntityChromeBridge.jsx" },
      { path: "SkillEdit.jsx", importPath: "../components/EntityChromeBridge.jsx" },
      { path: "KbEdit.jsx", importPath: "../components/EntityChromeBridge.jsx" },
      { path: "KbDetail.jsx", importPath: "../components/EntityChromeBridge.jsx" },
      { path: "Projects.jsx", importPath: "../components/EntityChromeBridge.jsx" },
      { path: "Goals.jsx", importPath: "../components/EntityChromeBridge.jsx" },
      { path: "settings/ProvidersTab.jsx", importPath: "../../components/EntityChromeBridge.jsx" },
    ];
    for (const { path, importPath } of entityRoutes) {
      const routeSource = readFileSync(resolve(import.meta.dirname, `../../ui/src/routes/${path}`), "utf8");
      expect(routeSource).toContain(importPath);
      expect(routeSource).not.toMatch(/function EntityChromeBridge/);
    }
  });
});
