import { describe, expect, it } from "vitest";
import {
  acpEndpointUnsupported,
  acpProfileForAgent,
  externalAgentDraft,
  externalAgentKind,
  externalAgentPayload,
  externalAgentVolatileState,
  normalizeMonoDiscovery,
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
    expect(externalAgentVolatileState(profile)).toMatchObject({ health: "healthy", capabilities: { sessions: true } });
  });

  it("builds a structured stdio payload without environment values", () => {
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
      allowTerminal: false,
      allowNetwork: false,
      allowMcp: false,
      configPolicyText: '{"mode":"constrained"}',
      sessionPolicyText: "{}",
    });

    expect(payload).toMatchObject({
      driver: "generic",
      command: "/opt/bin/acp-agent",
      args: ["serve", "--stdio"],
      cwd: "/workspace",
      envKeys: ["AGENT_TOKEN", "PATH"],
      configurationOwner: "client",
      permissionsPolicy: { filesystem: true, terminal: false, network: false, mcp: false },
      configPolicy: { mode: "constrained" },
      sessionPolicy: {},
    });
    expect(JSON.stringify(payload)).not.toContain("TOKEN=");
  });

  it("rejects malformed advanced policy JSON", () => {
    expect(() => externalAgentPayload({ displayName: "External", command: "/bin/agent", configPolicyText: "[]" }))
      .toThrow("Configuration policy must be a JSON object");
  });

  it("projects mono discovery onto its public sanitized contract", () => {
    const normalized = normalizeMonoDiscovery({
      schema: "mono-agent.acp-discovery.v1",
      sources: [{
        sourceId: "personal-agent",
        label: "Personal Agent",
        health: "running",
        ready: true,
        apiKey: "secret",
        baseUrl: "http://127.0.0.1:5555",
        configPath: "/private/mono-agent.config.json",
        config: { provider: "secret-provider" },
        capabilities: { sessions: true, clientMcp: false },
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
        capabilities: { sessions: true, clientMcp: false, filesystem: undefined, terminal: undefined },
      }],
    });
    const displayed = JSON.stringify(normalized);
    expect(displayed).not.toContain("secret");
    expect(displayed).not.toContain("127.0.0.1");
    expect(displayed).not.toContain("configPath");
  });

  it("recognizes optional ACP endpoints that are not available yet", () => {
    expect(acpEndpointUnsupported({ status: 404 })).toBe(true);
    expect(acpEndpointUnsupported({ status: 501 })).toBe(true);
    expect(acpEndpointUnsupported({ status: 500 })).toBe(false);
  });
});
