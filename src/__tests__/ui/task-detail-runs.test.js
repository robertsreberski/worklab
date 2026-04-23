import { describe, expect, it } from "vitest";
import { selectActiveRunId, selectHighlightedRunId } from "../../ui/src/routes/taskDetailRuns.js";

describe("task detail run selection", () => {
  it("preserves an active run that belongs to the current task", () => {
    expect(selectActiveRunId([{ id: "run-a" }, { id: "run-b" }], "run-b")).toBe("run-b");
  });

  it("replaces a stale active run with the current task's latest run", () => {
    expect(selectActiveRunId([{ id: "run-new" }], "run-old")).toBe("run-new");
  });

  it("preserves a newly started run while refreshed task data catches up", () => {
    expect(
      selectActiveRunId([{ id: "run-old" }], "run-new", { preserveMissingActive: true }),
    ).toBe("run-new");
  });

  it("clears active run state when the current task has no runs", () => {
    expect(selectActiveRunId([], "run-old")).toBeNull();
  });
});

describe("task detail run highlighting", () => {
  it("does not highlight the latest run by default", () => {
    expect(selectHighlightedRunId([{ id: "run-new" }, { id: "run-old" }], null)).toBeNull();
  });

  it("highlights a requested run that belongs to the current task", () => {
    expect(selectHighlightedRunId([{ id: "run-a" }, { id: "run-b" }], "run-b")).toBe("run-b");
  });

  it("clears a stale requested run instead of falling back to latest", () => {
    expect(selectHighlightedRunId([{ id: "run-new" }], "run-old")).toBeNull();
  });

  it("preserves a newly started run while refreshed task data catches up", () => {
    expect(
      selectHighlightedRunId([{ id: "run-old" }], "run-new", { preserveMissingActive: true }),
    ).toBe("run-new");
  });
});
