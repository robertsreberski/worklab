// Smoke matrix for the built-in provider bridges.
//
// The plan's Phase 7 verification calls for confirming that the runtime path
// goes through the package for each of: claude-sdk, claude-cli, pi-sdk, codex-app,
// opencode-app.
// We don't spin up the real providers (no API keys, no subprocess); we just
// resolve each bridge through the public API and assert it loads and exposes
// the expected execute() entry point.

import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveRuntimeBridge,
  runtimeCapabilities,
} from "../../ai/runtime/registry.js";

describe("runtime smoke matrix", () => {
  it("registers all built-in bridges", () => {
    const ids = listRuntimeBridges().map((bridge) => bridge.id).sort();
    expect(ids).toEqual(["claude", "claude-code", "codex-app", "opencode-app", "pi"]);
  });

  it("exposes capabilities for each kernel-level sdk family", () => {
    expect(runtimeCapabilities("claude").runtime).toBe("sdk");
    expect(runtimeCapabilities("pi").runtime).toBe("pi-agent");
    expect(runtimeCapabilities("codex").runtime).toBe("cli");
  });

  it.each([
    { case: "claude SDK", model: { sdk: "claude", model: "claude-sonnet-4-6" }, options: { executionMode: "sdk" }, expectedId: "claude" },
    { case: "claude CLI", model: { sdk: "claude", model: "claude-sonnet-4-6" }, options: { executionMode: "cli" }, expectedId: "claude-code" },
    { case: "pi SDK", model: { sdk: "pi", provider: "openai", model: "gpt-5.5" }, options: { executionMode: "sdk" }, expectedId: "pi" },
    { case: "codex CLI", model: { sdk: "codex", model: "gpt-5.5" }, options: { executionMode: "cli" }, expectedId: "codex-app" },
    { case: "opencode CLI", model: { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" }, options: { executionMode: "cli" }, expectedId: "opencode-app" },
  ])("resolves the $case bridge through the public API", async ({ model, options, expectedId }) => {
    const bridge = await resolveRuntimeBridge(model, options);
    expect(bridge.id).toBe(expectedId);
    expect(typeof bridge.execute).toBe("function");
    expect(bridge.capabilities).toBeDefined();
  });

  it("rejects unknown sdk families with a descriptive error", async () => {
    await expect(resolveRuntimeBridge({ sdk: "imaginary", model: "x" }, {}))
      .rejects.toThrow(/unsupported sdk: imaginary/);
  });

  it("falls through to the SDK bridge when executionMode is omitted", async () => {
    const bridge = await resolveRuntimeBridge({ sdk: "claude", model: "claude-sonnet-4-6" }, {});
    expect(bridge.id).toBe("claude");
  });
});
