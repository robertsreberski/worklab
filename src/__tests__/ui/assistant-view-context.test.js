import { describe, expect, it } from "vitest";
import {
  assistantViewContextFromHash,
  assistantViewContextFromLocation,
} from "../../ui/src/lib/assistantViewContext.js";

describe("assistant view context", () => {
  it("identifies task detail views with selected runs", () => {
    expect(assistantViewContextFromHash("#/tasks/task-1?run=run-1")).toMatchObject({
      route: "tasks",
      view: "task_detail",
      resource_type: "task",
      resource_id: "task-1",
      selected_run_id: "run-1",
      query: { run: "run-1" },
    });
  });

  it("identifies task edit views without claiming unsaved draft fields", () => {
    expect(assistantViewContextFromHash("#/tasks/task-1/edit")).toMatchObject({
      route: "tasks",
      view: "task_edit",
      resource_type: "task",
      resource_id: "task-1",
      mode: "edit",
    });
  });

  it("identifies non-task resources", () => {
    expect(assistantViewContextFromHash("#/projects/worklab")).toMatchObject({
      view: "project_detail",
      resource_type: "project",
      resource_id: "worklab",
    });
    expect(assistantViewContextFromHash("#/library/agents/assistant")).toMatchObject({
      view: "agent_detail",
      resource_type: "agent",
      resource_id: "assistant",
    });
    expect(assistantViewContextFromHash("#/library/teams/core-platform/edit")).toMatchObject({
      view: "team_edit",
      resource_type: "team",
      resource_id: "core-platform",
      mode: "edit",
    });
    expect(assistantViewContextFromHash("#/library/knowledge/current-decisions/edit")).toMatchObject({
      view: "knowledge_edit",
      resource_type: "knowledge",
      resource_id: "current-decisions",
      mode: "edit",
    });
  });

  it("uses blank task list as the default route", () => {
    expect(assistantViewContextFromHash("")).toMatchObject({
      route: "tasks",
      view: "task_list",
      path: "tasks",
    });
  });

  it("adds browser pathname when built from a location object", () => {
    expect(assistantViewContextFromLocation({
      hash: "#/settings/providers/provider-1",
      pathname: "/worklab",
    })).toMatchObject({
      view: "provider_detail",
      resource_type: "provider",
      resource_id: "provider-1",
      pathname: "/worklab",
    });
  });
});
