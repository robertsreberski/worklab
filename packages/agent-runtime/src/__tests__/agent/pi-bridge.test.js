import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  coerceMcpContent,
  getPiBuiltinTools,
  normalizeMcpToolParams,
  normalizePiBuiltinToolParams,
  resolveMcpStdioCwd,
} from "../../agent/tools/pi-bridge.js";

function makeSink(runDir) {
  return ({ filename, buffer }) => {
    const dir = join(runDir, "tool-output");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, filename);
    writeFileSync(target, buffer);
    return target;
  };
}

const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "worklab-pi-bridge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

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

  it("persists oversized MCP images before replacing them with compact text", () => {
    const root = tempWorkspace();
    const runArtifactDir = join(root, ".worklab-tmp", "artifacts", "run-image");
    const imageBytes = Buffer.from("large screenshot payload");
    const truncations = [];

    const content = coerceMcpContent(
      { content: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }] },
      {
        imageInlineMaxBytes: 10,
        persistArtifact: makeSink(runArtifactDir),
        toolName: "mcp__playwright__browser_take_screenshot",
        toolUseId: "shot-1",
        onTruncate: (event) => truncations.push(event),
      },
    );

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("saved_to=");
    const files = readdirSync(join(runArtifactDir, "tool-output"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/mcp__playwright__browser_take_screenshot.*\.png$/);
    expect(readFileSync(join(runArtifactDir, "tool-output", files[0])).toString()).toBe("large screenshot payload");
    expect(truncations[0]).toMatchObject({
      tool: "mcp__playwright__browser_take_screenshot",
      tool_use_id: "shot-1",
      original_bytes: imageBytes.length,
      max_bytes: 10,
    });
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
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout: 30,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      command: "ls",
      workdir: "/repo",
      timeout: 30000,
    });
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout: 120000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      command: "ls",
      workdir: "/repo",
      timeout: 120000,
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
    expect(bashSchema.properties.timeout.description).toContain("milliseconds");
    expect(bashSchema.properties.workdir.type).toBe("string");
  });

  it("resolves stdio MCP cwd from the run workdir", () => {
    expect(resolveMcpStdioCwd({}, "/repo/project")).toBe("/repo/project");
    expect(resolveMcpStdioCwd({ cwd: "tools" }, "/repo/project")).toBe("/repo/project/tools");
    expect(resolveMcpStdioCwd({ cwd: "/opt/mcp" }, "/repo/project")).toBe("/opt/mcp");
  });

  it("blocks non-read-only Bash commands when planning shell policy is enforced", async () => {
    const root = tempWorkspace();
    const bash = getPiBuiltinTools(["Bash"], {
      cwd: root,
      toolPolicy: { bashReadOnly: true },
    }).find((tool) => tool.name === "Bash");

    await expect(bash.execute("tool-write", { command: "touch should-not-exist" })).rejects.toThrow("Planning shell policy");
    const result = await bash.execute("tool-read", { command: "pwd" });
    expect(result.content[0].text.trim()).toContain("worklab-pi-bridge-");
  });

  it("routes Playwright MCP relative artifact filenames into the QA output directory", () => {
    const root = tempWorkspace();
    const qaOutputDir = join(root, ".worklab-tmp", "artifacts", "run-1");

    const screenshot = normalizeMcpToolParams("playwright", "browser_take_screenshot", {
      filename: "screens/title.png",
      fullPage: true,
    }, { qaOutputDir });
    expect(screenshot.filename).toBe(join(qaOutputDir, "screens", "title.png"));
    expect(existsSync(join(qaOutputDir, "screens"))).toBe(true);

    const snapshot = normalizeMcpToolParams("playwright", "browser_snapshot", {
      filename: "../snapshot.md",
    }, { qaOutputDir });
    expect(snapshot.filename).toBe(join(qaOutputDir, "snapshot.md"));

    const absolute = normalizeMcpToolParams("playwright", "browser_console_messages", {
      filename: "/tmp/console.log",
    }, { qaOutputDir });
    expect(absolute.filename).toBe("/tmp/console.log");

    const code = normalizeMcpToolParams("playwright", "browser_run_code", {
      filename: "result.json",
    }, { qaOutputDir });
    expect(code.filename).toBe("result.json");
  });

  it("passes abort signals to Bash tool execution", async () => {
    const root = tempWorkspace();
    const bash = getPiBuiltinTools(["Bash"], { cwd: root }).find((tool) => tool.name === "Bash");
    const ac = new AbortController();
    const promise = bash.execute("tool-1", {
      command: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      timeout: 120000,
    }, ac.signal);

    setTimeout(() => ac.abort(), 50);

    await expect(promise).rejects.toThrow("Error: Command aborted");
  });
});
