import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/sdk", () => ({ createOpencode: vi.fn() }));

import { createOpencode } from "@opencode-ai/sdk";
import { discoverOpencodeProviders } from "../../ai/providers/opencode-discovery.js";

beforeEach(() => createOpencode.mockReset());
afterEach(() => vi.clearAllMocks());

describe("discoverOpencodeProviders", () => {
  it("normalizes config.providers() into provider/model lists and closes the server", async () => {
    const close = vi.fn();
    createOpencode.mockResolvedValue({
      server: { url: "http://127.0.0.1:0", close },
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({
            data: {
              providers: [{
                id: "github-copilot",
                name: "GitHub Copilot",
                source: "api",
                models: {
                  "gpt-5.1": {
                    id: "gpt-5.1",
                    name: "GPT-5.1",
                    capabilities: { reasoning: true, toolcall: true, input: { image: false } },
                    limit: { context: 128000 },
                    status: "active",
                  },
                },
              }],
              default: {},
            },
          }),
        },
      },
    });

    const providers = await discoverOpencodeProviders();
    expect(providers).toEqual([{
      providerID: "github-copilot",
      name: "GitHub Copilot",
      source: "api",
      models: [{
        id: "gpt-5.1",
        name: "GPT-5.1",
        reasoning: true,
        toolCall: true,
        vision: false,
        contextWindow: 128000,
        status: "active",
      }],
    }]);
    expect(close).toHaveBeenCalled();
  });

  it("closes the server even when the providers call fails", async () => {
    const close = vi.fn();
    createOpencode.mockResolvedValue({
      server: { close },
      client: { config: { providers: vi.fn().mockResolvedValue({ error: { message: "boom" } }) } },
    });
    await expect(discoverOpencodeProviders()).rejects.toThrow(/boom/);
    expect(close).toHaveBeenCalled();
  });
});
