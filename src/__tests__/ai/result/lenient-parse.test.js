import { describe, expect, it } from "vitest";
import { parseWorklabResultLenient } from "../../../ai/result/lenient-parse.js";

describe("parseWorklabResultLenient", () => {
  it("returns null on empty input", () => {
    expect(parseWorklabResultLenient(null)).toBeNull();
    expect(parseWorklabResultLenient("")).toBeNull();
    expect(parseWorklabResultLenient("   ")).toBeNull();
  });

  it("parses bare worklab.v2 JSON", () => {
    const text = JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "All good",
      final_text: "Looks fine",
    });
    const result = parseWorklabResultLenient(text);
    expect(result).toMatchObject({
      schema: "worklab.v2",
      decision: "approve",
      summary: "All good",
      stage: "review",
    });
  });

  it("strips ```json fences", () => {
    const text = "```json\n" + JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "reject",
      summary: "Missing tests",
    }) + "\n```";
    const result = parseWorklabResultLenient(text);
    expect(result?.decision).toBe("reject");
  });

  it("strips ``` fences without language tag", () => {
    const text = "```\n" + JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "ok",
    }) + "\n```";
    const result = parseWorklabResultLenient(text);
    expect(result?.decision).toBe("approve");
  });

  it("handles markdown around JSON", () => {
    const text = `## Review

The implementation looks correct.

\`\`\`json
${JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "Tests pass",
      final_text: "LGTM",
    })}
\`\`\`

End of review.`;
    const result = parseWorklabResultLenient(text);
    expect(result?.decision).toBe("approve");
    expect(result?.summary).toBe("Tests pass");
  });

  it("recovers from a leading VERDICT heading + raw JSON", () => {
    const text = `### VERDICT: APPROVE

${JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "Done",
    })}`;
    const result = parseWorklabResultLenient(text);
    expect(result?.decision).toBe("approve");
  });

  it("synthesizes the schema marker when missing but shape is valid", () => {
    const text = JSON.stringify({
      stage: "review",
      decision: "reject",
      summary: "Broken layout",
      final_text: "needs work",
    });
    const result = parseWorklabResultLenient(text);
    expect(result?.schema).toBe("worklab.v2");
    expect(result?.decision).toBe("reject");
  });

  it("returns null when JSON parses but lacks a recognisable decision", () => {
    const text = JSON.stringify({ summary: "no decision here" });
    expect(parseWorklabResultLenient(text)).toBeNull();
  });

  it("returns null when there is no balanced JSON object", () => {
    expect(parseWorklabResultLenient("just prose, no JSON")).toBeNull();
    expect(parseWorklabResultLenient("```json\n{ broken")).toBeNull();
  });

  it("picks the largest balanced JSON object when multiple candidates exist", () => {
    const small = JSON.stringify({ note: "hello" });
    const big = JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "complete review summary with details",
      details: "x".repeat(40),
    });
    const text = `Some prose ${small} more prose ${big} even more prose`;
    const result = parseWorklabResultLenient(text);
    expect(result?.summary).toMatch(/complete review/);
  });

  it("parses with stage fallback when stage is omitted", () => {
    const text = JSON.stringify({
      schema: "worklab.v2",
      decision: "advance",
      summary: "execute done",
    });
    const result = parseWorklabResultLenient(text, { stage: "execute" });
    expect(result?.stage).toBe("execute");
    expect(result?.decision).toBe("advance");
  });
});
