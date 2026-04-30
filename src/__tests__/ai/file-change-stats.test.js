import { describe, expect, it } from "vitest";
import { statsForCompletedChange } from "../../ai/file-change-stats.js";

function snapshot(content) {
  return { exists: true, content, line_count: content.split("\n").length };
}

function missing() {
  return { exists: false, line_count: 0 };
}

describe("statsForCompletedChange", () => {
  it("emits hunks for a single-line edit", () => {
    const before = snapshot("a\nb\nc");
    const after = snapshot("a\nB\nc");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats).toMatchObject({
      before_lines: 3,
      after_lines: 3,
      added_lines: 1,
      removed_lines: 1,
      changed_lines: 2,
    });
    expect(stats.hunks).toEqual([{ start: 2, end: 2 }]);
  });

  it("emits multi-region hunks for non-adjacent edits", () => {
    const before = snapshot("a\nb\nc\nd\ne\nf\ng");
    const after = snapshot("A\nb\nc\nD\ne\nf\nG");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.hunks).toEqual([
      { start: 1, end: 1 },
      { start: 4, end: 4 },
      { start: 7, end: 7 },
    ]);
    expect(stats.added_lines).toBe(3);
    expect(stats.removed_lines).toBe(3);
  });

  it("merges consecutive added lines into a single hunk", () => {
    const before = snapshot("a\nb");
    const after = snapshot("a\nX\nY\nZ\nb");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.hunks).toEqual([{ start: 2, end: 4 }]);
    expect(stats.added_lines).toBe(3);
    expect(stats.removed_lines).toBe(0);
  });

  it("records pure-insert at the top of the file", () => {
    const before = snapshot("a\nb");
    const after = snapshot("X\na\nb");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.hunks).toEqual([{ start: 1, end: 1 }]);
  });

  it("returns no hunks for pure deletions (no line in after to point to)", () => {
    const before = snapshot("a\nX\nb");
    const after = snapshot("a\nb");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.added_lines).toBe(0);
    expect(stats.removed_lines).toBe(1);
    expect(stats.hunks).toEqual([]);
  });

  it("synthesizes a whole-file hunk for kind=add", () => {
    const after = snapshot("first\nsecond\nthird");
    const stats = statsForCompletedChange({ kind: "add" }, missing(), after);
    expect(stats).toMatchObject({
      before_lines: 0,
      after_lines: 3,
      added_lines: 3,
      removed_lines: 0,
    });
    expect(stats.hunks).toEqual([{ start: 1, end: 3 }]);
  });

  it("omits hunks for kind=delete (no after-line target)", () => {
    const before = snapshot("a\nb\nc");
    const stats = statsForCompletedChange({ kind: "delete" }, before, missing());
    expect(stats).toMatchObject({
      before_lines: 3,
      after_lines: 0,
      added_lines: 0,
      removed_lines: 3,
    });
    expect(stats.hunks).toBeUndefined();
  });

  it("falls back to count-only when files exceed the hunk line cap", () => {
    const beforeBody = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n");
    const afterBody = `${beforeBody}\nappended`;
    const stats = statsForCompletedChange(
      { kind: "update" },
      snapshot(beforeBody),
      snapshot(afterBody),
    );
    expect(stats.added_lines).toBe(1);
    expect(stats.removed_lines).toBe(0);
    expect(stats.hunks).toBeUndefined();
  });

  it("returns unavailable when files exceed the diff line limit", () => {
    const beforeBody = Array.from({ length: 4500 }, (_, i) => `line-${i + 1}`).join("\n");
    const afterBody = beforeBody;
    const stats = statsForCompletedChange(
      { kind: "update" },
      snapshot(beforeBody),
      snapshot(afterBody),
    );
    expect(stats.unavailable_reason).toBe("too_many_lines");
    expect(stats.hunks).toBeUndefined();
  });

  it("propagates unavailable_reason from snapshot when content is missing", () => {
    const before = { exists: true, line_count: 10, unavailable_reason: "too_large" };
    const after = { exists: true, line_count: 12 };
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.unavailable_reason).toBe("too_large");
    expect(stats.hunks).toBeUndefined();
  });
});
