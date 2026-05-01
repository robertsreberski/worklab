import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTaskDetailCache,
  readTaskDetailCache,
  taskDetailDataFromTaskSummary,
  writeTaskDetailCache,
  writeTaskDetailSummaryCache,
} from "../../ui/src/routes/TaskDetail.jsx";

describe("task detail cache", () => {
  beforeEach(() => {
    clearTaskDetailCache();
  });

  it("aliases full task-detail data by task id and task key", () => {
    writeTaskDetailCache({
      task: { id: "task-1", task_key: "T-1", title: "Full task", stage: "execute" },
      comments: [{ id: "comment-1", body: "cached" }],
      runs: [{ id: "run-1", status: "complete" }],
    });

    expect(readTaskDetailCache("task-1")?.task.title).toBe("Full task");
    expect(readTaskDetailCache("T-1")?.runs).toEqual([{ id: "run-1", status: "complete" }]);

    const cached = readTaskDetailCache("T-1");
    cached.runs.push({ id: "mutation-attempt" });
    expect(readTaskDetailCache("task-1")?.runs).toHaveLength(1);
  });

  it("builds a renderable task-detail shell from a commander task summary", () => {
    const summary = {
      id: "task-1",
      task_key: "T-1",
      title: "Summary task",
      stage: "execute",
      running_run_id: "run-1",
      running_run: {
        id: "run-1",
        status: "running",
        process_status: "running",
        started_at: 123,
      },
    };

    const detail = taskDetailDataFromTaskSummary(summary);
    expect(detail.task.title).toBe("Summary task");
    expect(detail.comments).toEqual([]);
    expect(detail.runs).toEqual([summary.running_run]);
    expect(detail.task.artifacts).toEqual([]);
    expect(detail.task.artifact_summary).toEqual({});
  });

  it("uses commander summaries as stale shells until full detail replaces them", () => {
    writeTaskDetailSummaryCache({
      id: "task-1",
      task_key: "T-1",
      title: "Summary task",
      stage: "execute",
    });

    expect(readTaskDetailCache("T-1")?.task.title).toBe("Summary task");

    writeTaskDetailCache({
      task: { id: "task-1", task_key: "T-1", title: "Full task", stage: "review" },
      comments: [{ id: "comment-1", body: "full" }],
      runs: [],
    });

    expect(readTaskDetailCache("task-1")?.task.stage).toBe("review");
    expect(readTaskDetailCache("T-1")?.comments).toEqual([{ id: "comment-1", body: "full" }]);
  });
});
