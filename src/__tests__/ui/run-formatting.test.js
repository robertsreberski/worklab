import { describe, expect, it } from "vitest";
import { formatCost, formatDuration, formatMode, formatTokens, runMetricItems } from "../../ui/src/lib/runFormatting.js";

describe("run formatting helpers", () => {
  it("formats common run values consistently", () => {
    expect(formatDuration(7420)).toBe("7.4s");
    expect(formatDuration(127_000)).toBe("2m 7s");
    expect(formatTokens(3300)).toBe("3.3k");
    expect(formatCost(0.0188)).toBe("$0.0188");
    expect(formatMode("in_review")).toBe("In Review");
  });

  it("builds compact metric items from a run", () => {
    expect(runMetricItems({
      started_at: 1000,
      ended_at: 8000,
      log: {
        input_tokens: 1200,
        output_tokens: 800,
        cost_usd: 0.0123,
        num_turns: 3,
      },
    })).toEqual([
      ["Duration", "7.0s"],
      ["Turns", "3"],
      ["Tokens", "2.0k"],
      ["Cost", "$0.0123"],
    ]);
  });
});
