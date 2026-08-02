import { describe, expect, it } from "vitest";
import {
  acpAuthMethods,
  acpEndpointUnsupported,
  acpOperationCancellable,
  acpOperationFinished,
  acpOperationId,
  acpProfileForAgent,
  externalAgentDraft,
  externalAgentKind,
  externalAgentMutationPayload,
  externalAgentPayload,
  externalAgentVolatileState,
  monoSourceCompatibilityHint,
  monoSourceImportable,
  normalizeMonoDiscovery,
  UNSUPPORTED_ACP_CLIENT_CAPABILITIES,
} from "../../ui/src/lib/externalAgents.js";

describe("external agent UI helpers", () => {
  it("derives one local or external kind from current and compatibility fields", () => {
    expect(externalAgentKind({ kind: "external" })).toBe("external");
    expect(externalAgentKind({ sdk: "acp" })).toBe("external");
    expect(externalAgentKind({ execution_mode: "acp" })).toBe("external");
    expect(externalAgentKind({ sdk: "claude", execution_mode: "cli" })).toBe("local");
  });

  it("finds camelCase or transitional snake_case profiles for an agent", () => {
    const profile = acpProfileForAgent([
      { id: "one", agent_name: "agent-one" },
      { id: "two", agentName: "agent-two", envKeys: ["TOKEN"] },
    ], "agent-two");

    expect(profile).toMatchObject({ id: "two", agentName: "agent-two", envKeys: ["TOKEN"] });
  });

  it("keeps volatile probe health and capabilities out of the editable draft", () => {
    const profile = {
      id: "profile-1",
      agentName: "external-one",
      displayName: "External One",
      command: "/opt/bin/acp-agent",
      args: ["serve", "--stdio"],
      envKeys: ["AGENT_TOKEN"],
      configPolicy: { neutral: "private-profile-value" },
      lastProbe: { status: "healthy", at: "2026-08-02T10:00:00Z" },
      capabilities: { sessions: true },
    };

    const draft = externalAgentDraft({ profile });

    expect(draft).toMatchObject({
      agentName: "external-one",
      displayName: "External One",
      command: "/opt/bin/acp-agent",
      argsText: "serve\n--stdio",
      envKeysText: "AGENT_TOKEN",
    });
    expect(draft).not.toHaveProperty("lastProbe");
    expect(draft).not.toHaveProperty("capabilities");
    expect(draft).not.toHaveProperty("allowFilesystem");
    expect(draft).not.toHaveProperty("allowTerminal");
    expect(draft).not.toHaveProperty("allowMcp");
    expect(draft).not.toHaveProperty("configPolicyText");
    expect(externalAgentVolatileState(profile)).toMatchObject({ health: "healthy", capabilities: { sessions: true } });
  });

  it("projects only advertised authentication method ids from probe results", () => {
    const methods = acpAuthMethods({
      lastProbe: {
        result: {
          authMethods: [
            { id: "oauth-browser", name: "Browser sign-in", type: "oauth" },
            { id: "device-code", name: "Device code", type: "terminal" },
            { name: "Missing id" },
          ],
        },
      },
    });

    expect(methods).toEqual([
      { id: "oauth-browser", label: "Browser sign-in", type: "oauth", description: "" },
      { id: "device-code", label: "Device code", type: "terminal", description: "" },
    ]);
  });

  it("builds a structured stdio payload without environment values or unsupported client capabilities", () => {
    const payload = externalAgentPayload({
      displayName: "External One",
      enabled: true,
      command: " /opt/bin/acp-agent ",
      argsText: "serve\n--stdio\n",
      cwd: " /workspace ",
      envKeysText: "AGENT_TOKEN\nPATH\nAGENT_TOKEN",
      configurationOwner: "client",
      workspaceOwner: "agent",
      mcpOwner: "agent",
      allowFilesystem: true,
      allowTerminal: true,
      allowNetwork: true,
      allowMcp: true,
      configPolicyText: '{"neutral":"private-policy-value"}',
      sessionPolicyText: "{}",
    });

    expect(payload).toMatchObject({
      driver: "generic",
      command: "/opt/bin/acp-agent",
      args: ["serve", "--stdio"],
      cwd: "/workspace",
      envKeys: ["AGENT_TOKEN", "PATH"],
      configurationOwner: "client",
      permissionsPolicy: { filesystem: false, terminal: false, network: true, mcp: false },
      configPolicy: {},
      sessionPolicy: {},
    });
    expect(JSON.stringify(payload)).not.toContain("TOKEN=");
    expect(JSON.stringify(payload)).not.toContain("private-policy-value");
  });

  it("describes every unsupported ACP client capability as unavailable", () => {
    expect(UNSUPPORTED_ACP_CLIENT_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "filesystem",
      "terminal",
      "mcp",
    ]);
    for (const capability of UNSUPPORTED_ACP_CLIENT_CAPABILITIES) {
      expect(capability.description).toMatch(/^Unavailable/u);
    }
  });

  it("ignores arbitrary configuration policy input and still validates session policy JSON", () => {
    expect(externalAgentPayload({
      displayName: "External",
      command: "/bin/agent",
      configPolicyText: '{"neutral":"private-policy-value"}',
      sessionPolicyText: "{}",
    }).configPolicy).toEqual({});
    expect(() => externalAgentPayload({ displayName: "External", command: "/bin/agent", sessionPolicyText: "[]" }))
      .toThrow("Session policy must be a JSON object");
  });

  it("rejects environment values instead of treating them as key names", () => {
    expect(() => externalAgentPayload({
      displayName: "External",
      command: "/bin/agent",
      envKeysText: "TOKEN=secret",
      configPolicyText: "{}",
      sessionPolicyText: "{}",
    })).toThrow("Environment entries must contain key names only");
  });

  it("keeps agent-owned and mono-managed launch policy out of ordinary patches", () => {
    const draft = {
      displayName: "Managed",
      description: "External",
      enabled: true,
      command: "/private/managed-agent",
      argsText: "--secret-shape",
      envKeysText: "SECRET_KEY",
      configurationOwner: "agent",
      workspaceOwner: "agent",
      mcpOwner: "agent",
      probeTimeoutMs: 12_345,
      allowFilesystem: true,
      allowTerminal: true,
      allowNetwork: true,
      allowMcp: true,
      configPolicyText: '{"mode":"descriptor-owned"}',
      sessionPolicyText: '{"resumeStrategy":"load"}',
    };

    const generic = externalAgentMutationPayload(draft, { driver: "generic" });
    expect(generic).toEqual({
      displayName: "Managed",
      description: "External",
      enabled: true,
      configurationOwner: "agent",
      workspaceOwner: "agent",
      mcpOwner: "agent",
      canonicalWorkspace: null,
    });
    expect(generic).not.toHaveProperty("command");
    expect(externalAgentMutationPayload(draft, { driver: "mono" })).toEqual({
      displayName: "Managed",
      description: "External",
      enabled: true,
    });
  });

  it("projects mono discovery onto its public sanitized contract", () => {
    const normalized = normalizeMonoDiscovery({
      schema: "mono-agent.acp-discovery.v1",
      sources: [{
        sourceId: "personal-agent",
        label: "Personal Agent",
        health: "running",
        ready: true,
        compatible: true,
        bridgeVersion: 1,
        protocolVersion: 1,
        installedVersion: "0.18.0",
        warnings: [],
        apiKey: "secret",
        baseUrl: "http://127.0.0.1:5555",
        configPath: "/private/mono-agent.config.json",
        config: { provider: "secret-provider" },
        capabilities: { sessions: true, clientMcp: false, clientFilesystem: false, clientTerminal: false },
        constraints: { promptContent: ["text", "resource_link"], attachments: false },
      }],
    });

    expect(normalized).toEqual({
      schema: "mono-agent.acp-discovery.v1",
      sources: [{
        sourceId: "personal-agent",
        label: "Personal Agent",
        health: "running",
        ready: true,
        imported: false,
        compatible: true,
        bridgeVersion: 1,
        protocolVersion: 1,
        installedVersion: "0.18.0",
        warnings: [],
        capabilities: { sessions: true, clientMcp: false, filesystem: false, terminal: false },
        constraints: { promptContent: ["text", "resource_link"], attachments: false },
      }],
    });
    const displayed = JSON.stringify(normalized);
    expect(displayed).not.toContain("secret");
    expect(displayed).not.toContain("127.0.0.1");
    expect(displayed).not.toContain("configPath");
  });

  it("keeps legacy mono sources visible but blocks import until their bridge is compatible", () => {
    const normalized = normalizeMonoDiscovery({
      schema: "mono-agent.acp-discovery.v1",
      sources: [{
        sourceId: "legacy-agent",
        label: "Legacy Agent",
        health: "running",
        ready: true,
        compatible: false,
        bridgeVersion: 0,
        protocolVersion: 0,
        installedVersion: "0.17.9",
        warnings: ["Legacy ACP bridge detected.\u0000", "Restart after upgrading."],
        apiKey: "private-token",
        config: { secret: "private-config" },
      }],
    });
    const source = normalized.sources[0];

    expect(source).toMatchObject({
      sourceId: "legacy-agent",
      health: "running",
      ready: true,
      compatible: false,
      bridgeVersion: 0,
      protocolVersion: 0,
      installedVersion: "0.17.9",
      warnings: ["Legacy ACP bridge detected.", "Restart after upgrading."],
    });
    expect(monoSourceImportable(source)).toBe(false);
    expect(monoSourceImportable({ ...source, compatible: true })).toBe(true);
    expect(monoSourceCompatibilityHint(source)).toBe(
      "Reported ACP bridge 0 / protocol 0. Upgrade mono-agent and restart this source, then retry.",
    );
    expect(JSON.stringify(normalized)).not.toMatch(/private-token|private-config|apiKey|config/u);
  });

  it("recognizes optional ACP endpoints that are not available yet", () => {
    expect(acpEndpointUnsupported({ status: 404 })).toBe(true);
    expect(acpEndpointUnsupported({ status: 501 })).toBe(true);
    expect(acpEndpointUnsupported({ status: 500 })).toBe(false);
  });

  it("offers cancellation only for identified nonterminal ACP operations", () => {
    expect(acpOperationId({ operation_id: "operation-1" })).toBe("operation-1");
    expect(acpOperationCancellable({ operationId: "operation-1", status: "running" })).toBe(true);
    expect(acpOperationCancellable({ id: "operation-1", state: "queued" })).toBe(true);
    expect(acpOperationFinished({ id: "operation-1", state: "completed" })).toBe(true);
    expect(acpOperationCancellable({ id: "operation-1", state: "cancelled" })).toBe(false);
    expect(acpOperationCancellable({ state: "running" })).toBe(false);
  });
});
