import { describe, expect, it, vi } from "vitest";
import { discoverMonoAcpAgents, MonoAcpDiscoveryError } from "../../core/acp-mono-discovery.js";

function descriptor(overrides = {}) {
  return {
    schema: "mono-agent.acp-discovery.v1",
    bridgeVersion: 1,
    protocolVersion: 1,
    sources: [{
      schema: "mono-agent.acp-source.v1",
      bridgeVersion: 1,
      protocolVersion: 1,
      installedVersion: "0.18.0",
      sourceId: "personal",
      label: "Personal Agent",
      health: "running",
      compatible: true,
      workspace: { path: "/tmp/personal", owner: "agent" },
      ownership: { configuration: "agent", workspace: "agent", mcp: "agent" },
      constraints: {
        promptContent: ["text", "resource_link"],
        clientMcp: false,
        clientFilesystem: false,
        clientTerminal: false,
        attachments: false,
        additionalDirectories: false,
      },
      warnings: [],
    }],
    ...overrides,
  };
}

function fakeExec(payload, { error = null, stderr = "" } = {}) {
  return vi.fn((_command, _args, _options, callback) => callback(error, JSON.stringify(payload), stderr));
}

describe("discoverMonoAcpAgents", () => {
  it("uses fixed argv without a shell and returns a sanitized descriptor", async () => {
    const input = descriptor();
    input.sources[0].apiKey = "secret";
    input.sources[0].operatorBaseUrl = "http://127.0.0.1:9999";
    const execFileImpl = fakeExec(input);
    const result = await discoverMonoAcpAgents({ command: "/opt/bin/mono-agent", execFileImpl, env: {} });
    expect(execFileImpl).toHaveBeenCalledWith(
      "/opt/bin/mono-agent",
      ["bridge", "acp", "--discover"],
      expect.objectContaining({ shell: false, timeout: 5_000 }),
      expect.any(Function),
    );
    expect(result.sources[0]).not.toHaveProperty("apiKey");
    expect(result.sources[0]).not.toHaveProperty("operatorBaseUrl");
    expect(result.sources[0]).toMatchObject({
      sourceId: "personal",
      workspace: { path: "/tmp/personal", owner: "agent" },
      constraints: { clientMcp: false },
    });
  });

  it("rejects incompatible versions and missing ACP baseline content", async () => {
    await expect(discoverMonoAcpAgents({ execFileImpl: fakeExec(descriptor({ protocolVersion: 2 })) }))
      .rejects.toMatchObject({ code: "incompatible_discovery" });
    const input = descriptor();
    input.sources[0].constraints.promptContent = ["text"];
    await expect(discoverMonoAcpAgents({ execFileImpl: fakeExec(input) }))
      .rejects.toMatchObject({ code: "incompatible_discovery" });
  });

  it("rejects non-JSON and keeps process stderr out of public errors", async () => {
    const notJson = vi.fn((_command, _args, _options, callback) => callback(null, "hello", ""));
    await expect(discoverMonoAcpAgents({ execFileImpl: notJson })).rejects.toBeInstanceOf(MonoAcpDiscoveryError);

    const processError = Object.assign(new Error("exit 1"), { code: 1 });
    const failed = vi.fn((_command, _args, _options, callback) => callback(processError, "", "private failure"));
    await expect(discoverMonoAcpAgents({ execFileImpl: failed }))
      .rejects.toMatchObject({ code: "discovery_failed", message: "mono-agent ACP discovery failed" });
  });
});
