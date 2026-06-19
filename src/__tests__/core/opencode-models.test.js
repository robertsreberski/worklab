import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOpencodeModelCatalogue,
  _resetOpencodeCatalogueCache,
} from "../../core/opencode-models.js";

const sampleProviders = [{
  providerID: "github-copilot",
  name: "GitHub Copilot",
  source: "api",
  models: [
    { id: "gpt-5.1", name: "GPT-5.1", reasoning: true, toolCall: true, vision: false, contextWindow: 128000, status: "active" },
    { id: "old-model", name: "Old", reasoning: false, toolCall: true, vision: false, contextWindow: 8000, status: "deprecated" },
  ],
}];

afterEach(() => _resetOpencodeCatalogueCache());

describe("getOpencodeModelCatalogue", () => {
  it("reports unavailable (no discovery) when the opencode binary is missing", async () => {
    const discover = vi.fn();
    const result = await getOpencodeModelCatalogue({ isBinaryAvailable: () => false, discover });
    expect(result.available).toBe(false);
    expect(result.groups).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("maps discovered providers into opencode:<provider>:<model> groups", async () => {
    const result = await getOpencodeModelCatalogue({
      isBinaryAvailable: () => true,
      discover: vi.fn().mockResolvedValue(sampleProviders),
    });
    expect(result.available).toBe(true);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group).toMatchObject({ id: "opencode:github-copilot", runtime_kind: "cli" });
    expect(group.models[0]).toMatchObject({
      value: "opencode:github-copilot:gpt-5.1",
      sdk: "opencode",
      runtime_kind: "cli",
      supports_mcp: true,
      supports_builtin_tools: false,
    });
    expect(group.models[0].capabilities).toMatchObject({ tool_use: true, reasoning: true });
    // deprecated upstream models are disabled
    expect(group.models[1]).toMatchObject({ value: "opencode:github-copilot:old-model", disabled: true });
  });

  it("caches discovery within the TTL and rediscovers after it expires", async () => {
    const discover = vi.fn().mockResolvedValue(sampleProviders);
    let clock = 1_000;
    const now = () => clock;
    await getOpencodeModelCatalogue({ isBinaryAvailable: () => true, discover, now, ttlMs: 1000 });
    await getOpencodeModelCatalogue({ isBinaryAvailable: () => true, discover, now, ttlMs: 1000 });
    expect(discover).toHaveBeenCalledTimes(1);
    clock += 2000;
    await getOpencodeModelCatalogue({ isBinaryAvailable: () => true, discover, now, ttlMs: 1000 });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable with the error reason when discovery throws", async () => {
    const result = await getOpencodeModelCatalogue({
      isBinaryAvailable: () => true,
      discover: vi.fn().mockRejectedValue(new Error("server boot failed")),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/server boot failed/);
    expect(result.groups).toEqual([]);
  });
});
