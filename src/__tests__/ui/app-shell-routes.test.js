import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_GROUPS, ROUTES } from "../../ui/src/components/AppShell.jsx";

const appShellPath = resolve(import.meta.dirname, "../../ui/src/components/AppShell.jsx");
const appPath = resolve(import.meta.dirname, "../../ui/src/App.jsx");
const commanderPath = resolve(import.meta.dirname, "../../ui/src/routes/Commander.jsx");
const primitiveIndexPath = resolve(import.meta.dirname, "../../ui/src/components/primitives/index.js");
const lazyRouteModules = [
  "Activity",
  "Agents",
  "DesignSystem",
  "Goals",
  "Knowledge",
  "Projects",
  "Providers",
  "Settings",
  "Skills",
  "TaskDetail",
  "TaskEdit",
  "Teams",
];

function moreRouteIds() {
  const source = readFileSync(appShellPath, "utf8");
  const match = source.match(/const MORE_ROUTE_IDS = \[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

describe("app shell routes", () => {
  it("exposes Teams in the Library navigation group", () => {
    const libraryGroup = ROUTE_GROUPS.find((group) => group.label === "Library");
    const libraryIds = libraryGroup?.routes.map((route) => route.id) || [];

    expect(libraryIds).toContain("teams");
    expect(libraryIds.indexOf("teams")).toBeLessThan(libraryIds.indexOf("agents"));
    expect(ROUTES.find((route) => route.id === "teams")).toMatchObject({
      label: "Teams",
      icon: "users",
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

  it("includes Teams in mobile More navigation", () => {
    const ids = moreRouteIds();

    expect(ids).toContain("teams");
    expect(ids.indexOf("teams")).toBeLessThan(ids.indexOf("skills"));
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
});
