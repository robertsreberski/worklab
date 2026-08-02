// Projects Worklab's tool policy onto what the target runtime can actually
// enforce.
//
// Worklab always sends an explicit `allowedTools` array — in "all" mode that is
// the full WORKLAB_BUILTIN_TOOLS list. Runtimes advertising
// `tool_policy: "projected"` (Claude SDK, Claude Code CLI, Pi) apply that list
// faithfully. Runtimes advertising `"allow_all_only"` (direct Codex, direct
// OpenCode) cannot: the app-server exposes its own fixed toolset, so
// agent-runtime fails the run closed rather than pretend a partial allowlist was
// applied (`skipped_capability_mismatch` / `codex_tool_policy_unsupported`).
// They accept an omitted allowlist, or any allowlist containing `"*"`, with no
// `disallowedTools`. A named-only list — which is what Worklab sends — still
// fails closed.
//
// Enumerating every builtin is semantically "no restriction", so for those
// runtimes we send the wildcard they understand. Nothing is lost — the
// enumerated list was never enforceable there in the first place. A genuine
// subset still fails, which is correct: the caller asked for a guarantee the
// runtime cannot make.
//
// This deliberately does NOT collapse Claude or Pi. `claude-sdk.js` maps `["*"]`
// onto `allowedTools: undefined`, which restores the Agent SDK's *default*
// toolset — wider than WORKLAB_BUILTIN_TOOLS. Collapsing there would silently
// hand Claude agents tools Worklab never granted.
//
// One exact planning restriction is translatable. Worklab's full "read-only
// shell" shape asks for every read/search/web tool, the native helper entry
// points and controls, Skill, and Bash while denying only Write/Edit. These
// runtimes express that as `permissionMode: "plan"` rather than as a tool list.
// Narrower shapes are not equivalent: notably, native plan mode would re-enable
// Bash for `read_only_no_shell` and would widen a custom subset. Those shapes
// must stay intact so the runtime fails closed.
//
// This requires agent-runtime >= 0.15.3 and will break if that floor is lowered.
// Under Codex's read-only sandbox every MCP tool call is gated behind
// `mcpServer/elicitation/request`; 0.15.2 refused all server-initiated requests
// and killed the turn on the planner's first `journal_append`, which is why an
// earlier attempt at this was reverted (mono-agent#553). 0.15.3 auto-approves
// that elicitation for MCP servers the host itself configured. Verified live on
// 0.15.3: plan mode + the worklab MCP server returns `{"ok":true}` with no
// refusal.
//
// Note the read-only sandbox bounds Codex's own filesystem and command
// execution, not what an MCP tool can change — a planner can still reach
// state-changing worklab tools such as kb_* and agent_create. That is governed
// by `agents.mcp_allowlist`, not by the planning policy, and is the same on
// every runtime.

import { RUNTIME_CAPABILITIES } from "@mono-agent/agent-runtime/ai/runtime/registry.js";
import { WORKLAB_BUILTIN_TOOLS } from "./builtin-tools.js";

const WILDCARD = "*";

// agent-runtime 0.15.2 models this as a capability (mono-agent#549), replacing a
// hardcoded bridge list here. The constant lives in ai/runtime/tool-policy.js,
// which is not on the package's explicit exports map, so compare the documented
// value rather than importing it.
const TOOL_POLICY_ALLOW_ALL_ONLY = "allow_all_only";

// Every bridge except pi-native maps this onto its provider's own read-only
// mode: Codex to sandbox `read-only`, Claude Code to `--sandbox read-only`,
// OpenCode to its plan permission config.
const PLAN_PERMISSION_MODE = "plan";

// Tools the planning policy grants that a provider-native read-only mode takes
// away, because agent-runtime pins `networkAccess: false` there. Kept in sync
// with READ_ONLY_TOOLS in planning-harness.js.
const NETWORK_TOOLS = ["WebFetch", "WebSearch"];
const NATIVE_PLAN_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  ...NETWORK_TOOLS,
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "Bash",
];
const NATIVE_PLAN_DISALLOWED_TOOLS = ["Write", "Edit"];

// Index RUNTIME_CAPABILITIES directly — runtimeCapabilities() throws on an
// unknown sdk (same reasoning as core/execenv.js). An absent or unrecognized
// `tool_policy` reads as projecting, which leaves the policy untouched: that can
// only fail closed, never silently widen an agent's toolset.
export function runtimeEnforcesToolPolicy(sdk) {
  return RUNTIME_CAPABILITIES[sdk]?.tool_policy !== TOOL_POLICY_ALLOW_ALL_ONLY;
}

function coversEveryBuiltin(allowed) {
  if (allowed.includes(WILDCARD)) return true;
  const granted = new Set(allowed);
  return WORKLAB_BUILTIN_TOOLS.every((tool) => granted.has(tool));
}

export function toolPolicyIsUnrestricted({ allowedTools, disallowedTools } = {}) {
  const allowed = Array.isArray(allowedTools) ? allowedTools : null;
  const disallowed = Array.isArray(disallowedTools) ? disallowedTools : [];
  return disallowed.length === 0
    && (allowed === null || allowed.includes(WILDCARD) || coversEveryBuiltin(allowed));
}

function hasExactly(tools, expected) {
  if (!Array.isArray(tools)) return false;
  const actual = new Set(tools);
  return actual.size === expected.length && expected.every((tool) => actual.has(tool));
}

function isNativePlanShape(allowed, disallowed) {
  return hasExactly(allowed, NATIVE_PLAN_ALLOWED_TOOLS)
    && hasExactly(disallowed, NATIVE_PLAN_DISALLOWED_TOOLS);
}

/**
 * @param {{sdk?: string}} resolved Resolved runtime model reference.
 * @param {{allowedTools?: string[], disallowedTools?: string[], planning?: boolean, permissionMode?: string}} [policy]
 * @returns {{allowedTools: string[]|undefined, disallowedTools: string[]|undefined, permissionMode: string|undefined, droppedNetworkTools: string[], unenforceable: boolean}}
 */
export function projectToolPolicy(resolved, {
  allowedTools,
  disallowedTools,
  planning = false,
  permissionMode,
} = {}) {
  const unchanged = {
    allowedTools,
    disallowedTools,
    permissionMode,
    droppedNetworkTools: [],
    unenforceable: false,
  };
  if (runtimeEnforcesToolPolicy(resolved?.sdk)) return unchanged;

  const allowed = Array.isArray(allowedTools) ? allowedTools : null;
  const disallowed = Array.isArray(disallowedTools) ? disallowedTools : [];

  // Already allow-all, or no policy at all. 0.15.2 unified the sentinel on
  // `includes("*")`, so a composed list like ["*", "Read"] is allow-all too and
  // must pass through rather than be reported unenforceable.
  if (disallowed.length === 0 && (allowed === null || allowed.includes(WILDCARD))) {
    return unchanged;
  }

  // "Everything Worklab offers" — express it the way the runtime understands.
  if (disallowed.length === 0 && allowed !== null && coversEveryBuiltin(allowed)) {
    return { ...unchanged, allowedTools: [WILDCARD], disallowedTools: [] };
  }

  // Translate only the full read-only-shell contract. Native plan mode is
  // stricter for filesystem writes through Bash, but otherwise grants exactly
  // the tools in this shape. Any narrower planning policy must fail closed.
  if (planning && isNativePlanShape(allowed, disallowed)) {
    return {
      allowedTools: [WILDCARD],
      disallowedTools: [],
      permissionMode: PLAN_PERMISSION_MODE,
      // ...but not stricter on network: the runtime pins networkAccess:false in
      // plan mode. The caller warns so this does not degrade silently.
      droppedNetworkTools: allowed === null
        ? [...NETWORK_TOOLS]
        : NETWORK_TOOLS.filter((tool) => allowed.includes(tool)),
      unenforceable: false,
    };
  }

  if (planning) return { ...unchanged, unenforceable: true };

  // An arbitrary subset has no native equivalent — a read-only sandbox
  // constrains writes, not *which* tools exist — so there is nothing honest to
  // translate to. Leave the policy intact and let the bridge report the
  // mismatch; the caller flags it in diagnostics.
  return { ...unchanged, unenforceable: true };
}
