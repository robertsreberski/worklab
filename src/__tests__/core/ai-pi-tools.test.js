import { describe, expect, it } from "vitest";
import { coerceMcpContent } from "../../core/ai-pi-tools.js";

describe("pi MCP tool helpers", () => {
  it("truncates oversized text results before returning them to the model", () => {
    const large = "x".repeat(80_000);
    const content = coerceMcpContent({ content: [{ type: "text", text: large }] });

    expect(content).toHaveLength(1);
    expect(content[0].text.length).toBeLessThan(large.length);
    expect(content[0].text).toContain("[truncated MCP tool result");
    expect(content[0].text).toContain("Use a more specific Worklab MCP tool");
  });

  it("leaves small text results unchanged", () => {
    const content = coerceMcpContent({ content: [{ type: "text", text: "ok" }] });

    expect(content).toEqual([{ type: "text", text: "ok" }]);
  });
});
