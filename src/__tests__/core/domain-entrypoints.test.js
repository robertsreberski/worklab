import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../core/db/index.js";
import { parseMentionToken } from "../../core/content/index.js";
import { loadConfig, newTaskId } from "../../core/platform/index.js";
import { parseCoordinatorPid } from "../../core/process/index.js";
import { createRunEventStore, runTodoStateSummary } from "../../core/runtime/index.js";
import { STAGES, taskStage } from "../../core/workflow/index.js";

describe("core domain entrypoints", () => {
  it("exposes stable workflow helpers", () => {
    expect(STAGES).toContain("plan");
    expect(taskStage({ stage: "execute" })).toBe("execute");
  });

  it("exposes stable runtime helpers", () => {
    expect(createRunEventStore).toBeTypeOf("function");
    expect(runTodoStateSummary(null)).toMatchObject({ total: 0 });
  });

  it("exposes stable content helpers", () => {
    expect(parseMentionToken("@task/ABC-123")).toMatchObject({ type: "task", id: "ABC-123" });
  });

  it("exposes stable platform and db helpers", () => {
    expect(newTaskId()).toBeTypeOf("string");
    expect(loadConfig({ WORKLAB_PORT: "7879" }).port).toBe(7879);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("exposes stable process helpers", () => {
    expect(parseCoordinatorPid("12345\nv2:incarnation")).toBe(12345);
  });
});
