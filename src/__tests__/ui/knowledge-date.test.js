import { describe, expect, it } from "vitest";
import { formatKnowledgeAge, knowledgeTimestamp } from "../../ui/src/routes/library/KnowledgeTab.jsx";

describe("knowledge date labels", () => {
  const now = Date.UTC(2026, 3, 25, 12, 0, 0);

  it("formats ISO timestamps without showing Invalid Date", () => {
    expect(formatKnowledgeAge("2026-04-22T12:00:00Z", now)).toBe("3d");
  });

  it("formats numeric timestamps", () => {
    expect(formatKnowledgeAge(now - 2 * 86_400_000, now)).toBe("2d");
  });

  it("returns an empty label for invalid timestamps", () => {
    expect(formatKnowledgeAge("not-a-date", now)).toBe("");
  });

  it("parses ISO and numeric strings for sorting", () => {
    expect(knowledgeTimestamp("2026-04-24T12:00:00Z")).toBe(Date.UTC(2026, 3, 24, 12, 0, 0));
    expect(knowledgeTimestamp(String(now))).toBe(now);
  });
});
