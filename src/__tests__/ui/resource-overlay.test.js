import { describe, expect, it } from "vitest";
import {
  resourceOverlayNavigationFromHash,
  resourceOverlayTargetFromHref,
} from "../../ui/src/lib/resourceOverlay.js";

describe("resource overlay routing", () => {
  it("maps entity badge hrefs to overlay targets", () => {
    expect(resourceOverlayTargetFromHref("#/library/agents/code-reviewer")).toMatchObject({
      kind: "agent",
      route: "library",
      tab: "agents",
      rest: ["code-reviewer"],
      href: "#/library/agents/code-reviewer",
    });
    expect(resourceOverlayTargetFromHref("/#/library/agents/code-reviewer")).toMatchObject({
      kind: "agent",
      href: "#/library/agents/code-reviewer",
    });
    expect(resourceOverlayTargetFromHref("#/library/skills/browser-use")).toMatchObject({
      kind: "skill",
      route: "library",
      tab: "skills",
      rest: ["browser-use"],
    });
    expect(resourceOverlayTargetFromHref("#/library/teams/core-platform")).toMatchObject({
      kind: "team",
      route: "library",
      tab: "teams",
      rest: ["core-platform"],
    });
    expect(resourceOverlayTargetFromHref("#/library/knowledge/auth-flow")).toMatchObject({
      kind: "kb",
      route: "library",
      tab: "knowledge",
      rest: ["auth-flow"],
    });
    expect(resourceOverlayTargetFromHref("#/projects/worklab")).toMatchObject({
      kind: "project",
      route: "projects",
      rest: ["worklab"],
    });
    expect(resourceOverlayTargetFromHref("#/goals/goal-1")).toMatchObject({
      kind: "goal",
      route: "goals",
      rest: ["goal-1"],
    });
    expect(resourceOverlayTargetFromHref("#/tasks/T-7")).toMatchObject({
      kind: "task",
      route: "tasks",
      rest: ["T-7"],
    });
    expect(resourceOverlayTargetFromHref("#/tasks/T-7?run=run-1")).toMatchObject({
      kind: "run",
      route: "tasks",
      rest: ["T-7"],
      query: { run: "run-1" },
    });
    expect(resourceOverlayTargetFromHref("#/tasks/T-7/edit")).toMatchObject({
      kind: "task",
      route: "tasks",
      rest: ["T-7", "edit"],
    });
  });

  it("ignores unsupported or collection-only hrefs for badge opening", () => {
    expect(resourceOverlayTargetFromHref("#/settings")).toBeNull();
    expect(resourceOverlayTargetFromHref("#/library/agents")).toBeNull();
    expect(resourceOverlayTargetFromHref("https://example.com")).toBeNull();
  });

  it("keeps modal-internal resource navigation inside the overlay", () => {
    expect(resourceOverlayNavigationFromHash("#/library/agents/code-reviewer")).toMatchObject({
      action: "open",
      target: { kind: "agent", href: "#/library/agents/code-reviewer" },
    });
    expect(resourceOverlayNavigationFromHash("#/library/agents")).toEqual({ action: "close" });
    expect(resourceOverlayNavigationFromHash("#/tasks")).toEqual({ action: "close" });
    expect(resourceOverlayNavigationFromHash("#/settings")).toEqual({ action: "ignore" });
  });
});
