import { describe, expect, it } from "vitest";
import { groupKeyFor } from "../../ui/src/routes/Commander.jsx";

describe("commander task grouping", () => {
  it("uses the saved task stage even when the latest run errored", () => {
    expect(groupKeyFor({
      stage: "done",
      last_run: { status: "error", process_status: "failed" },
    })).toBe("done");
  });

  it("uses the saved task stage even when dependencies are unresolved", () => {
    expect(groupKeyFor({
      stage: "execute",
      blocked_by: [{ stage: "review" }],
    })).toBe("execute");
  });

  it("falls back to execute for unknown stages", () => {
    expect(groupKeyFor({ stage: "legacy" })).toBe("execute");
  });
});
