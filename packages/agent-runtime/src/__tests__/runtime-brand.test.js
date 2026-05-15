import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();

vi.mock("../ai/runtime/registry.js", () => ({
  resolveRuntimeBridge: (...args) => resolveRuntimeBridgeMock(...args),
}));

const { createRuntime } = await import("../runtime.js");
const { DEFAULT_RUNTIME_BRAND, resolveRuntimeBrand } = await import("../runtime-brand.js");
const { readRuntimeBrand, resetToolRuntime } = await import(
  "../agent/tools/shared/runtime-context.js"
);

beforeEach(() => {
  executeMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
  resetToolRuntime();
});

afterEach(() => {
  resetToolRuntime();
});

describe("resolveRuntimeBrand", () => {
  it("returns the defaults when input is missing or not an object", () => {
    expect(resolveRuntimeBrand()).toEqual(DEFAULT_RUNTIME_BRAND);
    expect(resolveRuntimeBrand(null)).toEqual(DEFAULT_RUNTIME_BRAND);
    expect(resolveRuntimeBrand(42)).toEqual(DEFAULT_RUNTIME_BRAND);
  });

  it("applies recognised string overrides and ignores everything else", () => {
    const brand = resolveRuntimeBrand({
      schemaPrefix: "demo",
      mcpClientName: "demo-host",
      tempdirPrefix: "demo-cli-",
      unknownKey: "ignored",
      mcpClientVersion: 7, // non-string is ignored
    });
    expect(brand.schemaPrefix).toBe("demo");
    expect(brand.mcpClientName).toBe("demo-host");
    expect(brand.tempdirPrefix).toBe("demo-cli-");
    expect(brand.mcpClientVersion).toBe(DEFAULT_RUNTIME_BRAND.mcpClientVersion);
    expect(brand.unknownKey).toBeUndefined();
  });

  it("trims whitespace and rejects empty strings", () => {
    const brand = resolveRuntimeBrand({ schemaPrefix: "  spaced  ", mcpClientName: "   " });
    expect(brand.schemaPrefix).toBe("spaced");
    expect(brand.mcpClientName).toBe(DEFAULT_RUNTIME_BRAND.mcpClientName);
  });
});

describe("createRuntime + runtimeBrand", () => {
  it("publishes default brand into the tool runtime when none is supplied", () => {
    createRuntime();
    expect(readRuntimeBrand()).toEqual(DEFAULT_RUNTIME_BRAND);
  });

  it("publishes overrides supplied via host.runtimeBrand", () => {
    createRuntime({
      runtimeBrand: {
        schemaPrefix: "demo",
        mcpClientName: "demo-host",
        doctorCommand: "demo doctor",
      },
    });
    const brand = readRuntimeBrand();
    expect(brand.schemaPrefix).toBe("demo");
    expect(brand.mcpClientName).toBe("demo-host");
    expect(brand.doctorCommand).toBe("demo doctor");
    expect(brand.tempdirPrefix).toBe(DEFAULT_RUNTIME_BRAND.tempdirPrefix);
  });

  it("forwards the resolved brand under run() options to bridge.execute", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({ runtimeBrand: { schemaPrefix: "demo" } });
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [, options] = executeMock.mock.calls[0];
    expect(options.runtimeBrand?.schemaPrefix).toBe("demo");
  });
});

describe("brand-aware modules", () => {
  it("transcript snapshot schema id picks up the resolved brand prefix", async () => {
    createRuntime({ runtimeBrand: { schemaPrefix: "demo" } });
    const { buildTranscriptTailSnapshot } = await import("../agent/transcript.js");
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "final" },
    ];
    const snapshot = buildTranscriptTailSnapshot(events);
    expect(snapshot?.schema).toBe("demo.transcript-tail.v1");
  });

  it("ripgrep error message mentions the configured doctor command", async () => {
    createRuntime({ runtimeBrand: { doctorCommand: "demo doctor" } });
    const { ripgrepMissingMessage } = await import("../agent/tools/shared/ripgrep.js");
    expect(ripgrepMissingMessage()).toContain("`demo doctor`");
  });

  it("default brand preserves worklab strings (no regression for current host)", async () => {
    resetToolRuntime();
    const { buildTranscriptTailSnapshot } = await import("../agent/transcript.js");
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "final" },
    ];
    const snapshot = buildTranscriptTailSnapshot(events);
    expect(snapshot?.schema).toBe("worklab.transcript-tail.v1");
  });
});
