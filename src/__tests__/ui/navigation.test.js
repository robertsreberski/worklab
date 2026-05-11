import { describe, expect, it } from "vitest";
import { isAppRouteHash, normalizeHash, parseHashRoute } from "../../ui/src/lib/navigation.js";

describe("hash route parsing", () => {
  it("decodes mapped route segments and query values once", () => {
    expect(parseHashRoute("#/tasks/task%201/edit?run=run%2F1&label=hello+world")).toMatchObject({
      route: "tasks",
      rest: ["task 1", "edit"],
      path: "tasks/task%201/edit",
      queryString: "run=run%2F1&label=hello+world",
      query: {
        run: "run/1",
        label: "hello world",
      },
    });
  });

  it("uses the task list as the default mapped route", () => {
    expect(parseHashRoute("")).toMatchObject({
      route: "tasks",
      rest: [],
      path: "tasks",
      query: {},
    });
  });

  it("canonicalizes legacy resource route hashes into Library and Settings routes", () => {
    expect(normalizeHash("#/agents/code-reviewer")).toBe("#/library/agents/code-reviewer");
    expect(normalizeHash("#/teams/core-platform/edit")).toBe("#/library/teams/core-platform/edit");
    expect(normalizeHash("#/skills/ios-pwa")).toBe("#/library/skills/ios-pwa");
    expect(normalizeHash("#/knowledge/welcome/edit?draft=1")).toBe("#/library/knowledge/welcome/edit?draft=1");
    expect(normalizeHash("#/providers/openai")).toBe("#/settings/providers/openai");
    expect(normalizeHash("#/activity?range=7d")).toBe("#/runs?range=7d");

    expect(parseHashRoute("#/providers/openai")).toMatchObject({
      route: "settings",
      rest: ["providers", "openai"],
      path: "settings/providers/openai",
    });
  });

  it("does not treat in-page anchor hashes as app routes", () => {
    expect(isAppRouteHash("#main")).toBe(false);
    expect(isAppRouteHash("#/projects")).toBe(true);
    expect(parseHashRoute("#main")).toMatchObject({
      route: "tasks",
      rest: [],
      path: "tasks",
    });
  });
});
