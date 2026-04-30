import { describe, expect, it } from "vitest";
import {
  coerceMcpContent,
  getPiBuiltinTools,
  normalizePiBuiltinToolParams,
  resolveMcpStdioCwd,
} from "../../agent/tools/pi-bridge.js";

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

  it("hard-caps model-supplied built-in tool budgets during execution without schema maxima", () => {
    const toolLimits = {
      toolTextLimitChars: 16000,
      bashOutputLimitChars: 20000,
      searchResultLimit: 100,
    };

    expect(normalizePiBuiltinToolParams("Read", {
      file_path: "src/app.ts",
      max_output_chars: 50000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      file_path: "/repo/src/app.ts",
      max_output_chars: 16000,
    });
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "npm test",
      timeout: 999999,
      max_output_chars: 50000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      command: "npm test",
      workdir: "/repo",
      timeout: 120000,
      max_output_chars: 20000,
    });
    expect(normalizePiBuiltinToolParams("Glob", {
      pattern: "**/*",
      max_matches: 5000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      pattern: "**/*",
      path: undefined,
      limit: 100,
      workdir: "/repo",
    });
    expect(normalizePiBuiltinToolParams("Grep", {
      pattern: "needle",
      output_mode: "content",
      max_matches: 5000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      pattern: "needle",
      output_mode: "content",
      head_limit: 100,
      workdir: "/repo",
    });

    const tools = getPiBuiltinTools(["Read", "Bash"], { toolLimits });
    const readSchema = tools.find((tool) => tool.name === "Read").parameters;
    const bashSchema = tools.find((tool) => tool.name === "Bash").parameters;
    expect(readSchema.properties.max_output_chars.maximum).toBeUndefined();
    expect(readSchema.properties.start_line.type).toBe("integer");
    expect(bashSchema.properties.max_output_chars.maximum).toBeUndefined();
    expect(bashSchema.properties.timeout.maximum).toBeUndefined();
    expect(bashSchema.properties.workdir.type).toBe("string");
  });

  it("resolves stdio MCP cwd from the run workdir", () => {
    expect(resolveMcpStdioCwd({}, "/repo/project")).toBe("/repo/project");
    expect(resolveMcpStdioCwd({ cwd: "tools" }, "/repo/project")).toBe("/repo/project/tools");
    expect(resolveMcpStdioCwd({ cwd: "/opt/mcp" }, "/repo/project")).toBe("/opt/mcp");
  });
});
