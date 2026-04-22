import { describe, expect, it } from "vitest";
import { selectActiveRunId } from "../../ui/src/routes/taskDetailRuns.js";

describe("task detail run selection", () => {
  it("preserves an active run that belongs to the current task", () => {
    expect(selectActiveRunId([{ id: "run-a" }, { id: "run-b" }], "run-b")).toBe("run-b");
  });

  it("replaces a stale active run with the current task's latest run", () => {
    expect(selectActiveRunId([{ id: "run-new" }], "run-old")).toBe("run-new");
  });

  it("clears active run state when the current task has no runs", () => {
    expect(selectActiveRunId([], "run-old")).toBeNull();
  });
});
