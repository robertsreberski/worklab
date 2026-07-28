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
// The planning stage is the one restriction that *is* translatable. It asks for
// read-only, which these runtimes express as `permissionMode: "plan"` rather
// than as a tool list. Without the translation a Codex planner cannot run at
// all: the read-only planning policy adds `disallowedTools: ["Write","Edit"]`,
// and every non-empty denylist fails closed there.

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

  // The planning stage asks for read-only. These runtimes cannot say that with a
  // tool list, but they enforce it natively through `permissionMode: "plan"` —
  // which is stricter on the filesystem than the allowlist Worklab asked for,
  // because it also stops writes issued through a shell.
  if (planning) {
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

  // An arbitrary subset has no native equivalent — a read-only sandbox
  // constrains writes, not *which* tools exist — so there is nothing honest to
  // translate to. Leave the policy intact and let the bridge report the
  // mismatch; the caller flags it in diagnostics.
  return { ...unchanged, unenforceable: true };
}
