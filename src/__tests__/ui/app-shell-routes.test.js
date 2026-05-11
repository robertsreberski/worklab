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

describe("app shell routes", () => {
  it("exposes the grouped IA with Library and Settings as aggregate destinations", () => {
    const workGroup = ROUTE_GROUPS.find((group) => group.label === "Work");
    const buildGroup = ROUTE_GROUPS.find((group) => group.label === "Build");

    expect(workGroup?.routes.map((route) => route.id)).toEqual([
      "tasks",
      "goals",
      "projects",
    ]);
    expect(buildGroup?.routes.map((route) => route.id)).toEqual([
      "library",
      "runs",
      "settings",
    ]);
    expect(ROUTES.find((route) => route.id === "library")).toMatchObject({
      label: "Library",
      icon: "book",
    });
    expect(ROUTES.find((route) => route.id === "settings")).toMatchObject({
      label: "Settings",
      icon: "settings",
    });
  });

  it("exposes Goals as a first-class Work route", () => {
    const workGroup = ROUTE_GROUPS.find((group) => group.label === "Work");
    const workIds = workGroup?.routes.map((route) => route.id) || [];

    expect(workIds).toContain("goals");
    expect(workIds.indexOf("goals")).toBeGreaterThan(workIds.indexOf("tasks"));
    expect(workIds.indexOf("goals")).toBeLessThan(workIds.indexOf("projects"));
    expect(ROUTES.find((route) => route.id === "goals")).toMatchObject({
      label: "Goals",
      icon: "target",
    });
  });

  it("keeps aggregate Library and Settings destinations in mobile More navigation", () => {
    const ids = moreRouteIds();

    expect(ids).toEqual(["library", "settings"]);
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
    for (const routeModule of lazyRouteModules) {
      expect(source).not.toContain(`import { ${routeModule} } from "./routes/${routeModule}.jsx";`);
      expect(source).toContain(`import("./routes/${routeModule}.jsx")`);
    }
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
