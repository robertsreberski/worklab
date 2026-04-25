import { describe, it, expect } from "vitest";
import { statusMeta } from "../../ui/src/components/primitives/StatusPill.jsx";

describe("statusMeta", () => {
  it("returns meta for known statuses", () => {
    expect(statusMeta("plan").label).toBe("Plan");
    expect(statusMeta("execute").label).toBe("Execute");
    expect(statusMeta("review").label).toBe("Review");
    expect(statusMeta("done").label).toBe("Done");
    expect(statusMeta("error").label).toBe("Error");
  });

  it("returns semantic colors", () => {
    expect(statusMeta("execute").color).toBe("var(--status-todo)");
    expect(statusMeta("running").color).toBe("var(--status-progress)");
    expect(statusMeta("done").color).toBe("var(--status-done)");
    expect(statusMeta("error").color).toBe("var(--status-error)");
  });

  it("falls back gracefully for unknown status", () => {
    const meta = statusMeta("surprise");
    expect(meta.label).toBe("surprise");
    expect(meta.color).toBe("var(--status-muted)");
  });

  it("maps run-style aliases to semantic colors", () => {
    expect(statusMeta("running").color).toBe("var(--status-progress)");
    expect(statusMeta("complete").color).toBe("var(--status-done)");
    expect(statusMeta("failed").color).toBe("var(--status-error)");
    expect(statusMeta("cancelled").color).toBe("var(--status-muted)");
  });
});
