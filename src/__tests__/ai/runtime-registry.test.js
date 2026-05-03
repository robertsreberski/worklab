import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveRuntimeBridge,
  runtimeCapabilities,
} from "../../ai/runtime/registry.js";

describe("AI runtime bridge registry", () => {
  it("registers only active canonical runtime bridges", () => {
    expect(listRuntimeBridges().map((bridge) => bridge.id).sort()).toEqual(["claude", "pi"]);
  });

  it("resolves canonical Pi and Claude model references", async () => {
    await expect(resolveRuntimeBridge({ sdk: "pi", provider: "openai", model: "gpt-5.5" }))
      .resolves.toMatchObject({ id: "pi" });
    await expect(resolveRuntimeBridge({ sdk: "claude", model: "claude-sonnet-4-6" }))
      .resolves.toMatchObject({ id: "claude" });
  });

  it("rejects reserved runtime ids until dedicated bridges are added", async () => {
    await expect(resolveRuntimeBridge({ sdk: "codex", model: "gpt-5.5" }))
      .rejects.toThrow(/unsupported sdk/i);
    await expect(resolveRuntimeBridge({ sdk: "claude-code", model: "claude-sonnet-4-6" }))
      .rejects.toThrow(/unsupported sdk/i);
  });

  it("exposes bridge-owned capabilities", () => {
    expect(runtimeCapabilities("pi")).toMatchObject({ kind: "pi", runtime: "pi-agent" });
    expect(runtimeCapabilities("claude")).toMatchObject({ kind: "claude", runtime: "sdk" });
  });
});
