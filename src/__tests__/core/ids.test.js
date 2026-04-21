import { describe, it, expect } from "vitest";
import { newTaskId, newCommentId, newRunId, newProviderId } from "../../core/ids.js";

describe("ids", () => {
  it("newTaskId is 21 chars", () => expect(newTaskId()).toHaveLength(21));
  it("newCommentId is 21 chars", () => expect(newCommentId()).toHaveLength(21));
  it("newRunId is 21 chars", () => expect(newRunId()).toHaveLength(21));
  it("newProviderId is 12 chars", () => expect(newProviderId()).toHaveLength(12));
  it("ids are unique", () => {
    const s = new Set();
    for (let i = 0; i < 1000; i++) s.add(newTaskId());
    expect(s.size).toBe(1000);
  });
});
