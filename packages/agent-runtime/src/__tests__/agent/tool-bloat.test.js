import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyToolBloatGuard,
  BINARY_BLOAT_TOOLS,
  DEFAULT_TOOL_BLOAT_CONFIG,
  MAX_TOOL_RESULT_BYTES,
  summarisePayload,
  wrapToolsWithBloatGuard,
} from "../../agent/tool-bloat.js";

const TEST_TOOL = "mcp__playwright__browser_take_screenshot";

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wl-tool-bloat-"));
}

// Mirrors worklab's createToolOutputSink (src/core/tool-artifacts.js): writes
// every persisted block to {runDir}/tool-output/{filename}. Tests against this
// sink so they continue to assert on disk paths.
function makeSink(runDir) {
  return ({ filename, buffer }) => {
    if (!runDir) return null;
    const dir = join(runDir, "tool-output");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, filename);
    writeFileSync(target, buffer);
    return target;
  };
}

describe("tool-bloat constants", () => {
  it("exposes a 256 KB default cap", () => {
    expect(MAX_TOOL_RESULT_BYTES).toBe(262144);
    expect(DEFAULT_TOOL_BLOAT_CONFIG.maxBytes).toBe(MAX_TOOL_RESULT_BYTES);
  });

  it("knows the playwright bloat offenders", () => {
    expect(BINARY_BLOAT_TOOLS).toContain("mcp__playwright__browser_take_screenshot");
    expect(BINARY_BLOAT_TOOLS).toContain("mcp__playwright__browser_snapshot");
  });
});

describe("summarisePayload", () => {
  let runDir;

  beforeEach(() => { runDir = makeRunDir(); });
  afterEach(() => { if (runDir) rmSync(runDir, { recursive: true, force: true }); });

  it("passes payloads under the limit through unchanged", () => {
    const blocks = [{ type: "text", text: "hello world" }];
    const result = summarisePayload("Bash", blocks, makeSink(runDir), { maxBytes: 1024 });
    expect(result.truncated).toBe(false);
    expect(result.savedPaths).toEqual([]);
    expect(result.originalBytes).toBe(11);
    expect(result.rewrittenBlocks).toBe(blocks);
  });

  it("preserves payloads exactly at the limit", () => {
    const text = "x".repeat(64);
    const blocks = [{ type: "text", text }];
    const result = summarisePayload("Bash", blocks, makeSink(runDir), { maxBytes: 64 });
    expect(result.truncated).toBe(false);
    expect(result.rewrittenBlocks[0].text).toBe(text);
  });

  it("truncates oversized text payloads and persists the original", () => {
    const text = "abcdefghij".repeat(120);
    const blocks = [{ type: "text", text }];
    const result = summarisePayload("Bash", blocks, makeSink(runDir), {
      maxBytes: 256,
      toolUseId: "tool_abc",
    });
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(1200);
    expect(result.savedPaths).toHaveLength(1);
    expect(existsSync(result.savedPaths[0])).toBe(true);
    expect(readFileSync(result.savedPaths[0], "utf8")).toBe(text);
    expect(result.rewrittenBlocks).toHaveLength(1);
    expect(result.rewrittenBlocks[0].type).toBe("text");
    expect(result.rewrittenBlocks[0].text).toMatch(/truncated tool_result/);
    expect(result.rewrittenBlocks[0].text).toMatch(/Bash/);
    expect(result.rewrittenBlocks[0].text).toMatch(/1200/);
  });

  it("persists image content blocks as binary, not as text", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const filler = Buffer.alloc(2048, 0xff);
    const data = Buffer.concat([png, filler]).toString("base64");
    const blocks = [{ type: "image", data, mimeType: "image/png" }];
    const result = summarisePayload(TEST_TOOL, blocks, makeSink(runDir), {
      maxBytes: 256,
      toolUseId: "tool_img_1",
    });
    expect(result.truncated).toBe(true);
    expect(result.savedPaths).toHaveLength(1);
    expect(result.savedPaths[0]).toMatch(/\.png$/);
    const saved = readFileSync(result.savedPaths[0]);
    expect(saved.subarray(0, 8).equals(png)).toBe(true);
    expect(saved.length).toBe(png.length + filler.length);
    expect(result.rewrittenBlocks[0].type).toBe("text");
    expect(result.rewrittenBlocks[0].text).toMatch(/saved_to/);
  });

  it("survives missing runDir without throwing", () => {
    const blocks = [{ type: "text", text: "x".repeat(2048) }];
    const result = summarisePayload("Bash", blocks, null, { maxBytes: 256 });
    expect(result.truncated).toBe(true);
    expect(result.savedPaths).toEqual([]);
    expect(result.rewrittenBlocks[0].text).toMatch(/persistence unavailable/);
  });
});

describe("applyToolBloatGuard", () => {
  let runDir;
  beforeEach(() => { runDir = makeRunDir(); });
  afterEach(() => { if (runDir) rmSync(runDir, { recursive: true, force: true }); });

  it("returns the original result when under the cap", async () => {
    const original = {
      content: [{ type: "text", text: "ok" }],
      details: { tool: "Bash" },
    };
    const result = await applyToolBloatGuard("Bash", Promise.resolve(original), {
      persistArtifact: makeSink(runDir),
      maxBytes: 1024,
    });
    expect(result).toBe(original);
  });

  it("rewrites oversized results and emits diagnostics on details", async () => {
    const text = "y".repeat(2048);
    const original = {
      content: [{ type: "text", text }],
      details: { tool: "Bash" },
    };
    const truncations = [];
    const result = await applyToolBloatGuard("Bash", Promise.resolve(original), {
      persistArtifact: makeSink(runDir),
      maxBytes: 256,
      toolUseId: "call_1",
      onTruncate: (event) => truncations.push(event),
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toMatch(/truncated tool_result/);
    expect(result.details.tool_payload_truncated).toBe(true);
    expect(result.details.tool_payload_original_bytes).toBe(2048);
    expect(result.details.tool_payload_saved_paths).toHaveLength(1);
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({
      tool: "Bash",
      tool_use_id: "call_1",
      original_bytes: 2048,
      max_bytes: 256,
    });
    expect(truncations[0].saved_paths).toHaveLength(1);
  });
});

describe("wrapToolsWithBloatGuard", () => {
  let runDir;
  beforeEach(() => { runDir = makeRunDir(); });
  afterEach(() => { if (runDir) rmSync(runDir, { recursive: true, force: true }); });

  it("post-processes execute results from each wrapped tool", async () => {
    const events = [];
    const tools = [
      {
        name: "BigText",
        execute: async () => ({
          content: [{ type: "text", text: "z".repeat(4096) }],
          details: {},
        }),
      },
      {
        name: "SmallText",
        execute: async () => ({
          content: [{ type: "text", text: "tiny" }],
          details: {},
        }),
      },
    ];
    const wrapped = wrapToolsWithBloatGuard(tools, {
      persistArtifact: makeSink(runDir),
      maxBytes: 256,
      onTruncate: (e) => events.push(e),
    });
    const big = await wrapped[0].execute("call_big", {});
    const small = await wrapped[1].execute("call_small", {});
    expect(big.details.tool_payload_truncated).toBe(true);
    expect(small).toMatchObject({ content: [{ type: "text", text: "tiny" }] });
    expect(events.map((e) => e.tool)).toEqual(["BigText"]);
  });

  it("preserves tool metadata other than execute", () => {
    const tool = {
      name: "Sample",
      label: "Sample",
      description: "desc",
      parameters: { type: "object" },
      executionMode: "sequential",
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    };
    const [wrapped] = wrapToolsWithBloatGuard([tool], { runDir });
    expect(wrapped.name).toBe("Sample");
    expect(wrapped.label).toBe("Sample");
    expect(wrapped.parameters).toEqual({ type: "object" });
    expect(wrapped.executionMode).toBe("sequential");
  });
});
