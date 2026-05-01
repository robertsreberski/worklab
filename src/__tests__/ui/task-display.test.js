import { describe, expect, it } from "vitest";
import {
  agentModelEffortLabel,
  hasRunError,
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
    expect(agentModelEffortLabel({ model: "codex:gpt-5.5", effort: "medium" })).toBe("codex:gpt-5.5 · medium effort");
    expect(agentModelEffortLabel({ model: "claude:claude-sonnet-4-6" })).toBe("claude:claude-sonnet-4-6");
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
