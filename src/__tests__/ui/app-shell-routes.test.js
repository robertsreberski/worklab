import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_GROUPS, ROUTES } from "../../ui/src/components/AppShell.jsx";

const appShellPath = resolve(import.meta.dirname, "../../ui/src/components/AppShell.jsx");

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

  it("includes Teams in mobile More navigation", () => {
    const ids = moreRouteIds();

    expect(ids).toContain("teams");
    expect(ids.indexOf("teams")).toBeLessThan(ids.indexOf("skills"));
  });
});
