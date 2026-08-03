import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OWNERS = new Set(["client", "agent"]);

export class AcpPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AcpPreflightError";
    this.code = code;
  }
}

export function acpProfileIdFromAgent(agent) {
  const model = typeof agent?.model === "string" ? agent.model : "";
  const usesAcp = agent?.sdk === "acp" || model.startsWith("acp:") || agent?.execution_mode === "acp";
  if (!usesAcp) return null;
  const profileId = model.startsWith("acp:") ? model.slice(4) : "";
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new AcpPreflightError("acp_binding_invalid", "external agent must use model acp:<profile-id>");
  }
  if (agent?.sdk !== "acp" || agent?.execution_mode !== "acp") {
    throw new AcpPreflightError(
      "acp_binding_invalid",
      "external agent must use sdk=acp and execution_mode=acp",
    );
  }
  return profileId;
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new AcpPreflightError("acp_workspace_invalid", `${label} must be an absolute directory`);
  }
  try {
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new AcpPreflightError("acp_workspace_invalid", `${label} must resolve to a directory`);
  }
}

/**
 * Validate an ACP binding before Worklab creates a run row or worktree.
 * Returns null for ordinary local agents so existing providers are untouched.
 */
export function assertAcpTaskRunPreflight({
  agent,
  profile,
  runKind = "task",
  workspace,
  willUseWorktree = false,
} = {}) {
  const profileId = acpProfileIdFromAgent(agent);
  if (!profileId) return null;
  if (runKind !== "task") {
    throw new AcpPreflightError(
      "acp_surface_unsupported",
      "external ACP agents currently support task runs only",
    );
  }
  if (!profile || profile.id !== profileId || profile.agent_name !== agent.name) {
    throw new AcpPreflightError("acp_profile_missing", "external agent is not bound to its ACP profile");
  }
  if (!new Set(["generic", "mono"]).has(profile.driver)) {
    throw new AcpPreflightError("acp_profile_invalid", "ACP profile driver is invalid");
  }
  for (const field of ["configuration_owner", "workspace_owner", "mcp_owner"]) {
    if (!OWNERS.has(profile[field])) {
      throw new AcpPreflightError("acp_profile_invalid", `ACP profile ${field} is invalid`);
    }
  }
  if (profile.driver === "mono" && (
    profile.configuration_owner !== "agent"
    || profile.workspace_owner !== "agent"
    || profile.mcp_owner !== "agent"
  )) {
    throw new AcpPreflightError("acp_profile_invalid", "mono-agent ACP profiles must own configuration, workspace, and MCP");
  }

  let canonicalWorkspace = null;
  if (profile.workspace_owner === "agent") {
    if (willUseWorktree) {
      throw new AcpPreflightError(
        "acp_worktree_unsupported",
        "agent-owned ACP workspaces cannot use Worklab run worktrees",
      );
    }
    canonicalWorkspace = canonicalDirectory(profile.canonical_workspace, "ACP canonical workspace");
    const requestedWorkspace = canonicalDirectory(workspace, "task workspace");
    if (requestedWorkspace !== canonicalWorkspace) {
      throw new AcpPreflightError(
        "acp_workspace_mismatch",
        "task workspace does not match the agent-owned ACP workspace",
      );
    }
  }

  return {
    profileId,
    providerKind: "acp",
    workspaceOwner: profile.workspace_owner,
    configurationOwner: profile.configuration_owner,
    mcpOwner: profile.mcp_owner,
    canonicalWorkspace,
  };
}
