import { describe, it, expect } from "vitest";
import { statusMeta } from "../../ui/src/components/primitives/StatusPill.jsx";

describe("statusMeta", () => {
  it("returns meta for known statuses", () => {
    expect(statusMeta("todo").label).toBe("Todo");
    expect(statusMeta("in_progress").label).toBe("In progress");
    expect(statusMeta("in_review").label).toBe("In review");
    expect(statusMeta("done").label).toBe("Done");
    expect(statusMeta("error").label).toBe("Blocked");
  });

  it("returns semantic colors", () => {
    expect(statusMeta("todo").color).toBe("var(--teal)");
    expect(statusMeta("in_progress").color).toBe("var(--yellow)");
    expect(statusMeta("done").color).toBe("var(--green)");
    expect(statusMeta("error").color).toBe("var(--red)");
  });

  it("falls back gracefully for unknown status", () => {
    const meta = statusMeta("surprise");
    expect(meta.label).toBe("surprise");
    expect(meta.color).toBe("var(--muted)");
  });

  it("maps run-style aliases to semantic colors", () => {
    expect(statusMeta("running").color).toBe("var(--yellow)");
    expect(statusMeta("complete").color).toBe("var(--green)");
    expect(statusMeta("failed").color).toBe("var(--red)");
    expect(statusMeta("cancelled").color).toBe("var(--muted)");
  });
});
