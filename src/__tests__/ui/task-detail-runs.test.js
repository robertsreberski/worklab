import { describe, expect, it } from "vitest";
import {
  optimisticTaskDetailRunStarted,
  selectActiveRunId,
  selectHighlightedRunId,
} from "../../ui/src/routes/taskDetailRuns.js";

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

describe("task detail optimistic run state", () => {
  it("adds a minimal running run and preserves existing task detail data", () => {
    const startedAt = 1_714_000_000_000;
    const detail = optimisticTaskDetailRunStarted({
      task: {
        id: "task-1",
        task_key: "T-1",
        title: "Demo",
        owner_agent: "builder",
        stage: "execute",
      },
      comments: [{ id: "comment-1", body: "keep" }],
      runs: [{ id: "run-old", status: "complete", process_status: "complete" }],
    }, {
      runId: "run-new",
      startedAt,
    });

    expect(detail.task.running_run_id).toBe("run-new");
    expect(detail.task.running_run).toMatchObject({
      id: "run-new",
      status: "running",
      process_status: "running",
      agent_name: "builder",
      started_at: startedAt,
    });
    expect(detail.comments).toEqual([{ id: "comment-1", body: "keep" }]);
    expect(detail.runs.map((run) => run.id)).toEqual(["run-new", "run-old"]);
  });
});
