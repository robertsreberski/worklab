// Projects Worklab's tool policy onto what the target runtime can actually
// enforce.
//
// Worklab always sends an explicit `allowedTools` array — in "all" mode that is
// the full WORKLAB_BUILTIN_TOOLS list. The Claude SDK, Claude Code CLI, and Pi
// bridges project that list faithfully. The direct Codex and OpenCode bridges
// cannot: the app-server exposes its own fixed toolset, so agent-runtime fails
// the run closed rather than pretend a partial allowlist was applied
// (`skipped_capability_mismatch` / `codex_tool_policy_unsupported`). It accepts
// only the exact allow-all contract: `["*"]`, or omitted, with no
// `disallowedTools`.
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

import { WORKLAB_BUILTIN_TOOLS } from "./builtin-tools.js";

const WILDCARD = "*";

// Runtimes whose bridges reject anything but exact allow-all. `codex` covers
// both the app-server bridge and the Codex CLI path in claude-cli.js.
const NON_PROJECTING_SDKS = new Set(["codex", "opencode"]);

export function runtimeEnforcesToolPolicy(sdk) {
  return !NON_PROJECTING_SDKS.has(sdk);
}

function coversEveryBuiltin(allowed) {
  if (allowed.includes(WILDCARD)) return true;
  const granted = new Set(allowed);
  return WORKLAB_BUILTIN_TOOLS.every((tool) => granted.has(tool));
}

/**
 * @param {{sdk?: string}} resolved Resolved runtime model reference.
 * @param {{allowedTools?: string[], disallowedTools?: string[]}} [policy]
 * @returns {{allowedTools: string[]|undefined, disallowedTools: string[]|undefined, unenforceable: boolean}}
 */
export function projectToolPolicy(resolved, { allowedTools, disallowedTools } = {}) {
  const unchanged = { allowedTools, disallowedTools, unenforceable: false };
  if (runtimeEnforcesToolPolicy(resolved?.sdk)) return unchanged;

  const allowed = Array.isArray(allowedTools) ? allowedTools : null;
  const disallowed = Array.isArray(disallowedTools) ? disallowedTools : [];

  // Already the wildcard contract, or no policy at all.
  if (disallowed.length === 0 && (allowed === null || (allowed.length === 1 && allowed[0] === WILDCARD))) {
    return unchanged;
  }

  // "Everything Worklab offers" — express it the way the runtime understands.
  if (disallowed.length === 0 && allowed !== null && coversEveryBuiltin(allowed)) {
    return { allowedTools: [WILDCARD], disallowedTools: [], unenforceable: false };
  }

  // A real restriction the runtime cannot honour. Leave the policy intact so the
  // bridge reports the mismatch itself; the caller flags it in diagnostics.
  return { allowedTools, disallowedTools, unenforceable: true };
}
