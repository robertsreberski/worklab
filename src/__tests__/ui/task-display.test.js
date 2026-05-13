import { describe, expect, it } from "vitest";
import {
  agentModelEffortLabel,
  hasRunError,
  middleTruncatePath,
  taskDisplayKey,
  taskRecoveryLabel,
  taskRecoveryState,
  taskRouteId,
} from "../../ui/src/lib/display.js";

describe("task display helpers", () => {
  it("uses public task keys when present", () => {
    expect(taskDisplayKey({ id: "abc123456789", task_key: "T-42" })).toBe("T-42");
    expect(taskRouteId({ id: "abc123456789", task_key: "T-42" })).toBe("T-42");
  });

  it("keeps full internal ids in routes when no public key is available", () => {
    expect(taskDisplayKey({ id: "abcdef1234567890" })).toBe("ABCDEF");
    expect(taskRouteId({ id: "abcdef1234567890" })).toBe("abcdef1234567890");
  });

  it("describes agents with full model reference and effort", () => {
    expect(agentModelEffortLabel({ model: "pi:openai-codex:gpt-5.5", effort: "medium" })).toBe("pi:openai-codex:gpt-5.5 · medium effort");
    expect(agentModelEffortLabel({ model: "claude:claude-sonnet-4-6" })).toBe("claude:claude-sonnet-4-6");
  });

  it("middle-truncates long display paths without changing short or non-path text", () => {
    expect(middleTruncatePath("/Users/worklab/projects/mobile-layout-project/src/ui/src/routes/TaskDetail.jsx", 43))
      .toBe("/Users/worklab/../src/routes/TaskDetail.jsx");
    expect(middleTruncatePath("C:\\Users\\worklab\\projects\\mobile-layout-project\\src\\routes\\TaskDetail.jsx", 44))
      .toBe("C:\\Users\\worklab\\..\\routes\\TaskDetail.jsx");
    expect(middleTruncatePath("/Users/worklab/app", 42)).toBe("/Users/worklab/app");
    expect(middleTruncatePath("long-unbreakable-token-without-separators", 18)).toBe("long-unbreakable-token-without-separators");
  });

  it("hides stale run errors while a rerun is active", () => {
    expect(hasRunError({
      running_run_id: "run-active",
      last_run: { status: "error", process_status: "failed" },
    })).toBe(false);
    expect(hasRunError({
      runs: [
        { id: "run-old", status: "error", process_status: "failed" },
        { id: "run-active", status: "running", process_status: "running" },
      ],
    })).toBe(false);
    expect(hasRunError({
      last_run: { status: "error", process_status: "failed" },
    })).toBe(true);
  });

  it("does not surface stale run errors after task completion", () => {
    expect(hasRunError({
      stage: "done",
      last_run: { status: "error", process_status: "failed", failure_kind: "spawn" },
    })).toBe(false);
    expect(hasRunError({
      stage: "execute",
      last_run: { status: "error", process_status: "failed", failure_kind: "spawn" },
    })).toBe(true);
  });

  it("labels active recovery retries from compact task metadata", () => {
    const task = {
      stage: "review",
      last_run: {
        recovery: {
          active_run_id: "run-retry",
          stage: "review",
          subkind: "terminated",
        },
      },
    };

    expect(taskRecoveryState(task)).toMatchObject({ active_run_id: "run-retry" });
    expect(taskRecoveryLabel(task)).toBe("Retrying review");
    expect(taskRecoveryLabel({
      stage: "execute",
      last_run: { recovery: { active_run_id: "run-retry", stage: "execute" } },
    })).toBe("Auto-retrying");
    expect(taskRecoveryLabel({ last_run: { recovery: { active_run_id: null } } })).toBeNull();
  });
});
