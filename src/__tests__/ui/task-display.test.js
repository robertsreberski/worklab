import { describe, expect, it } from "vitest";
import { agentModelEffortLabel, taskDisplayKey, taskRouteId } from "../../ui/src/lib/display.js";

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
});
