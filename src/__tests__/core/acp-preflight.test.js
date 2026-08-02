import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acpProfileIdFromAgent, assertAcpTaskRunPreflight } from "../../core/acp-preflight.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function localAgent(overrides = {}) {
  return { name: "local", sdk: "pi", model: "pi:openai:gpt-5", execution_mode: "sdk", ...overrides };
}

function acpAgent(overrides = {}) {
  return { name: "external", sdk: "acp", model: "acp:profile-1", execution_mode: "acp", ...overrides };
}

function profile(workspace, overrides = {}) {
  return {
    id: "profile-1",
    agent_name: "external",
    driver: "generic",
    configuration_owner: "client",
    workspace_owner: "client",
    mcp_owner: "client",
    canonical_workspace: null,
    ...overrides,
  };
}

describe("ACP task-run preflight", () => {
  it("leaves local agents unchanged and validates the canonical ACP binding", () => {
    expect(acpProfileIdFromAgent(localAgent())).toBeNull();
    expect(assertAcpTaskRunPreflight({ agent: localAgent() })).toBeNull();
    expect(assertAcpTaskRunPreflight({
      agent: acpAgent(),
      profile: profile(null),
      runKind: "task",
      workspace: "/tmp",
    })).toMatchObject({ profileId: "profile-1", providerKind: "acp" });
  });

  it("rejects partial or mismatched bindings", () => {
    expect(() => acpProfileIdFromAgent(acpAgent({ execution_mode: "cli" })))
      .toThrow(/execution_mode=acp/);
    expect(() => assertAcpTaskRunPreflight({
      agent: acpAgent(),
      profile: profile(null, { id: "profile-2" }),
      workspace: "/tmp",
    })).toThrow(/not bound/);
  });

  it("allows only task runs", () => {
    expect(() => assertAcpTaskRunPreflight({
      agent: acpAgent(),
      profile: profile(null),
      runKind: "automation",
      workspace: "/tmp",
    })).toThrow(/task runs only/);
  });

  it("requires exact canonical workspace ownership and rejects worktrees", () => {
    const owned = temporaryDirectory("worklab-acp-owned-");
    const other = temporaryDirectory("worklab-acp-other-");
    const agentOwned = profile(owned, {
      workspace_owner: "agent",
      canonical_workspace: owned,
    });
    expect(assertAcpTaskRunPreflight({
      agent: acpAgent(), profile: agentOwned, workspace: owned,
    })).toMatchObject({ workspaceOwner: "agent", canonicalWorkspace: owned });
    expect(() => assertAcpTaskRunPreflight({
      agent: acpAgent(), profile: agentOwned, workspace: other,
    })).toThrow(/does not match/);
    expect(() => assertAcpTaskRunPreflight({
      agent: acpAgent(), profile: agentOwned, workspace: owned, willUseWorktree: true,
    })).toThrow(/cannot use Worklab run worktrees/);
  });

  it("enforces mono-agent ownership invariants", () => {
    expect(() => assertAcpTaskRunPreflight({
      agent: acpAgent(),
      profile: profile(null, { driver: "mono", workspace_owner: "agent", canonical_workspace: "/tmp" }),
      workspace: "/tmp",
    })).toThrow(/must own configuration/);
  });
});
