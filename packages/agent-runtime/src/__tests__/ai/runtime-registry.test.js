import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveRuntimeBridge,
  runtimeCapabilities,
} from "../../ai/runtime/registry.js";

describe("AI runtime bridge registry", () => {
  it("registers SDK and CLI bridges for both provider families", () => {
    expect(listRuntimeBridges().map((bridge) => bridge.id).sort())
      .toEqual(["claude", "claude-code", "codex-app", "opencode-app", "pi"]);
  });

  it("resolves canonical Pi and Claude model references to SDK bridges by default", async () => {
    await expect(resolveRuntimeBridge({ sdk: "pi", provider: "openai", model: "gpt-5.5" }))
      .resolves.toMatchObject({ id: "pi" });
    await expect(resolveRuntimeBridge({ sdk: "claude", model: "claude-sonnet-4-6" }))
      .resolves.toMatchObject({ id: "claude" });
    await expect(resolveRuntimeBridge({ sdk: "codex", model: "gpt-5.5" }))
      .rejects.toThrow(/unsupported sdk/i);
  });

  it("routes to CLI bridges when execution_mode='cli'", async () => {
    await expect(resolveRuntimeBridge({ sdk: "claude", model: "claude-sonnet-4-6" }, { executionMode: "cli" }))
      .resolves.toMatchObject({ id: "claude-code" });
    await expect(resolveRuntimeBridge({ sdk: "codex", model: "gpt-5.5" }, { executionMode: "cli" }))
      .resolves.toMatchObject({ id: "codex-app" });
    await expect(resolveRuntimeBridge({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" }, { executionMode: "cli" }))
      .resolves.toMatchObject({ id: "pi" });
  });

  it("rejects unrecognized sdk values regardless of execution mode", async () => {
    await expect(resolveRuntimeBridge({ sdk: "claude-code", model: "claude-sonnet-4-6" }))
      .rejects.toThrow(/unsupported sdk/i);
    await expect(resolveRuntimeBridge({ sdk: "claude-code", model: "claude-sonnet-4-6" }, { executionMode: "cli" }))
      .rejects.toThrow(/unsupported sdk/i);
  });

  it("exposes bridge-owned capabilities", () => {
    expect(runtimeCapabilities("pi")).toMatchObject({ kind: "pi", runtime: "pi-agent" });
    expect(runtimeCapabilities("claude")).toMatchObject({ kind: "claude", runtime: "sdk" });
  });
});
