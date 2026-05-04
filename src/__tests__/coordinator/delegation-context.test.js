import { describe, expect, it } from "vitest";
import { buildDelegationContextBlock } from "../../coordinator/task-watcher.js";

describe("buildDelegationContextBlock", () => {
  it("returns empty when there is no parent task", () => {
    expect(buildDelegationContextBlock({})).toBe("");
  });

  it("includes parent task ref, run id, summary, and final_text", () => {
    const block = buildDelegationContextBlock({
      parentTask: { task_key: "T-12", id: "task-1", title: "Migrate auth" },
      parentRunId: "run-abc",
      parentResult: {
        summary: "Picked the JWT path",
        final_text: "Decided JWT over sessions; rationale below.",
      },
    });
    expect(block).toContain("## Parent task context");
    expect(block).toContain("**T-12**");
    expect(block).toContain("Migrate auth");
    expect(block).toContain("`run-abc`");
    expect(block).toContain("Parent summary: Picked the JWT path");
    expect(block).toContain("Decided JWT over sessions");
    expect(block).toContain("don't redo work it already covers");
  });

  it("falls back to details when final_text is empty", () => {
    const block = buildDelegationContextBlock({
      parentTask: { id: "task-2", title: "Investigation" },
      parentResult: { summary: "found a clue", details: "the index uses btree, not hash" },
    });
    expect(block).toContain("**Parent details:**");
    expect(block).toContain("the index uses btree, not hash");
    expect(block).not.toContain("Parent final_text");
  });

  it("clips overlong details to 2000 chars", () => {
    const huge = "x".repeat(5000);
    const block = buildDelegationContextBlock({
      parentTask: { id: "task-3", title: "Big" },
      parentResult: { details: huge },
    });
    const detailsIdx = block.indexOf("**Parent details:**");
    const detailsBody = block.slice(detailsIdx);
    expect(detailsBody.length).toBeLessThan(2300);
  });

  it("works with no parentResult at all (just produces the breadcrumb)", () => {
    const block = buildDelegationContextBlock({
      parentTask: { task_key: "T-1", id: "task-1", title: "Bare delegation" },
    });
    expect(block).toContain("## Parent task context");
    expect(block).toContain("**T-1**");
    expect(block).not.toContain("Parent summary");
    expect(block).not.toContain("Parent final_text");
  });
});
