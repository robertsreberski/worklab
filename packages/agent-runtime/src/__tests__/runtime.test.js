import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();

vi.mock("../ai/runtime/registry.js", () => ({
  resolveRuntimeBridge: (...args) => resolveRuntimeBridgeMock(...args),
}));

const { createRuntime } = await import("../runtime.js");
const { readToolRuntime, resetToolRuntime } = await import("../agent/tools/shared/runtime-context.js");

beforeEach(() => {
  executeMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
  resetToolRuntime();
});

afterEach(() => {
  resetToolRuntime();
});

describe("createRuntime", () => {
  it("exposes run() and configureTools() and configures the tool runtime from host options", () => {
    const runtime = createRuntime({
      workspace: "/tmp/work",
      repoRoot: "/tmp/repo",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
    });
    expect(typeof runtime.run).toBe("function");
    expect(typeof runtime.configureTools).toBe("function");
    expect(readToolRuntime()).toMatchObject({
      workspace: "/tmp/work",
      repoRoot: "/tmp/repo",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
    });
  });

  it("ignores host keys it does not recognize when configuring the tool runtime", () => {
    createRuntime({ workspace: "/tmp/work", unrelated: "ignored" });
    expect(readToolRuntime().workspace).toBe("/tmp/work");
    expect(readToolRuntime().unrelated).toBeUndefined();
  });

  it("does not touch the tool runtime when no tool keys are provided", () => {
    createRuntime({ resolveCustomPricing: () => null });
    expect(readToolRuntime().workspace).toBeUndefined();
    expect(readToolRuntime().ripgrepPath).toBeUndefined();
  });

  it("run() throws without a model", async () => {
    const runtime = createRuntime();
    await expect(runtime.run("sys", {})).rejects.toThrow(/requires options.model/);
  });

  it("run() resolves the bridge with the supplied model and executionMode", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    const model = { sdk: "claude", model: "claude-sonnet-4-6" };
    await runtime.run("sys", { model, executionMode: "cli", liveInput: false });
    expect(resolveRuntimeBridgeMock).toHaveBeenCalledWith(model, {
      executionMode: "cli",
      liveInput: false,
    });
  });

  it("run() defaults executionMode to 'sdk' and liveInput to false when omitted", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    await runtime.run("sys", { model: { sdk: "claude", model: "x" } });
    expect(resolveRuntimeBridgeMock).toHaveBeenCalledWith(
      { sdk: "claude", model: "x" },
      { executionMode: "sdk", liveInput: false },
    );
  });

  it("run() forwards host defaults under per-call options to bridge.execute", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const resolveCustomPricing = () => null;
    const persistArtifact = () => null;
    const onCompactionRecorded = () => undefined;
    const resolvePiApiKey = async () => "key";
    const runtime = createRuntime({
      resolveCustomPricing,
      persistArtifact,
      onCompactionRecorded,
      resolvePiApiKey,
    });
    await runtime.run("sys", {
      model: { sdk: "claude", model: "x" },
      cwd: "/work",
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [systemPrompt, options] = executeMock.mock.calls[0];
    expect(systemPrompt).toBe("sys");
    expect(options).toMatchObject({
      cwd: "/work",
      executionMode: "sdk",
      resolveCustomPricing,
      persistArtifact,
      onCompactionRecorded,
      resolvePiApiKey,
    });
  });

  it("run() lets per-call options override host defaults", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostResolver = () => "host";
    const callResolver = () => "call";
    const runtime = createRuntime({ resolveCustomPricing: hostResolver });
    await runtime.run("sys", {
      model: { sdk: "claude", model: "x" },
      resolveCustomPricing: callResolver,
    });
    expect(executeMock.mock.calls[0][1].resolveCustomPricing).toBe(callResolver);
  });

  it("configureTools() updates the tool runtime after construction", () => {
    const runtime = createRuntime({ workspace: "/tmp/initial" });
    runtime.configureTools({ workspace: "/tmp/updated", ripgrepPath: "/opt/rg" });
    expect(readToolRuntime()).toMatchObject({
      workspace: "/tmp/updated",
      ripgrepPath: "/opt/rg",
    });
  });

  it("configureTools() ignores unknown keys", () => {
    const runtime = createRuntime();
    runtime.configureTools({ workspace: "/w", bogus: "nope" });
    expect(readToolRuntime().workspace).toBe("/w");
    expect(readToolRuntime().bogus).toBeUndefined();
  });
});
