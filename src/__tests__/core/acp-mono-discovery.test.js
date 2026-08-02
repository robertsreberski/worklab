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
    const result = await discoverMonoAcpAgents({
      command: "/opt/bin/mono-agent",
      execFileImpl,
      env: {
        HOME: "/tmp/home",
        PATH: "/opt/bin:/usr/bin",
        TMPDIR: "/tmp/private",
        WORKLAB_MONO_AGENT_BIN: "/ignored/by-explicit-command",
        WORKLAB_SERVICE_TOKEN: "must-not-reach-child",
        OPENAI_API_KEY: "must-not-reach-child",
      },
    });
    expect(execFileImpl).toHaveBeenCalledWith(
      "/opt/bin/mono-agent",
      ["bridge", "acp", "--discover"],
      expect.objectContaining({ shell: false, timeout: 5_000 }),
      expect.any(Function),
    );
    const childOptions = execFileImpl.mock.calls[0][2];
    expect(childOptions.env).toEqual({
      HOME: "/tmp/home",
      PATH: "/opt/bin:/usr/bin",
      TMPDIR: "/tmp/private",
    });
    expect(JSON.stringify(childOptions.env)).not.toMatch(/must-not-reach-child|WORKLAB_MONO_AGENT_BIN/u);
    expect(result.sources[0]).not.toHaveProperty("apiKey");
    expect(result.sources[0]).not.toHaveProperty("operatorBaseUrl");
    expect(result.sources[0]).toMatchObject({
      sourceId: "personal",
      workspace: { path: "/tmp/personal", owner: "agent" },
      constraints: { clientMcp: false },
    });
  });

  it("honors the configured binary without forwarding Worklab secrets", async () => {
    const execFileImpl = fakeExec(descriptor());
    await discoverMonoAcpAgents({
      execFileImpl,
      env: {
        WORKLAB_MONO_AGENT_BIN: "/custom/mono-agent",
        PATH: "/custom",
        WORKLAB_SERVICE_TOKEN: "sentinel-secret",
      },
    });
    expect(execFileImpl.mock.calls[0][0]).toBe("/custom/mono-agent");
    expect(execFileImpl.mock.calls[0][2].env).toEqual({ PATH: "/custom" });
  });

  it("preserves sanitized legacy sources without failing the compatible catalog", async () => {
    const input = descriptor();
    input.sources.unshift({
      ...input.sources[0],
      bridgeVersion: 0,
      protocolVersion: 0,
      installedVersion: "unknown",
      sourceId: "legacy",
      label: "Legacy Agent",
      compatible: false,
      warnings: ["bridge_metadata_missing_or_invalid"],
    });
    const result = await discoverMonoAcpAgents({ execFileImpl: fakeExec(input) });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      sourceId: "legacy",
      bridgeVersion: 0,
      protocolVersion: 0,
      compatible: false,
      warnings: ["bridge_metadata_missing_or_invalid"],
    });
    expect(result.sources[1]).toMatchObject({ sourceId: "personal", compatible: true });
  });

  it("passes cancellation to the child process and rejects promptly", async () => {
    let childOptions;
    const execFileImpl = vi.fn((_command, _args, options) => {
      childOptions = options;
    });
    const controller = new AbortController();
    const pending = discoverMonoAcpAgents({ execFileImpl, signal: controller.signal });
    const reason = Object.assign(new Error("request timed out"), { code: "timeout" });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(childOptions.signal).toBe(controller.signal);
  });

  it("rejects incompatible versions and missing ACP baseline content", async () => {
    await expect(discoverMonoAcpAgents({ execFileImpl: fakeExec(descriptor({ protocolVersion: 2 })) }))
      .rejects.toMatchObject({ code: "incompatible_discovery" });
    const input = descriptor();
    input.sources[0].constraints.promptContent = ["text"];
    await expect(discoverMonoAcpAgents({ execFileImpl: fakeExec(input) }))
      .rejects.toMatchObject({ code: "incompatible_discovery" });

    const unsupported = descriptor();
    unsupported.sources[0].constraints.clientMcp = true;
    await expect(discoverMonoAcpAgents({ execFileImpl: fakeExec(unsupported) }))
      .rejects.toMatchObject({ code: "incompatible_discovery" });
  });

  it.each([
    ["workspace owner", (source) => { source.workspace.owner = "client"; }],
    ["missing workspace owner", (source) => { delete source.workspace.owner; }],
    ["configuration owner", (source) => { source.ownership.configuration = "client"; }],
    ["workspace policy owner", (source) => { source.ownership.workspace = "client"; }],
    ["MCP owner", (source) => { source.ownership.mcp = "client"; }],
    ["missing ownership", (source) => { delete source.ownership; }],
  ])("rejects rather than rewriting an untrusted %s", async (_label, mutate) => {
    const input = descriptor();
    mutate(input.sources[0]);

    await expect(discoverMonoAcpAgents({ execFileImpl: fakeExec(input) }))
      .rejects.toMatchObject({
        code: "incompatible_discovery",
        message: "mono-agent ACP source must retain agent ownership",
      });
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
