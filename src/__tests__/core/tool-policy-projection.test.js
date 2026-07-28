import { describe, expect, it } from "vitest";
import { projectToolPolicy, runtimeEnforcesToolPolicy } from "../../core/tool-policy-projection.js";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";

const ALL_BUILTINS = [...WORKLAB_BUILTIN_TOOLS];

describe("projectToolPolicy", () => {
  it("leaves the enforcing runtimes untouched", () => {
    for (const sdk of ["claude", "pi"]) {
      expect(runtimeEnforcesToolPolicy(sdk)).toBe(true);
      const projected = projectToolPolicy({ sdk }, { allowedTools: ALL_BUILTINS, disallowedTools: [] });
      // Collapsing Claude to ["*"] would map onto allowedTools: undefined in the
      // SDK bridge, restoring its default toolset — wider than Worklab grants.
      expect(projected.allowedTools).toEqual(ALL_BUILTINS);
      expect(projected.unenforceable).toBe(false);
    }
  });

  // agent-runtime 0.15.x fails a direct Codex/OpenCode run closed unless the
  // policy is exactly ["*"] with no disallowedTools. Worklab's "all" mode sends
  // every builtin by name, which meant every codex run returned
  // skipped_capability_mismatch / codex_tool_policy_unsupported.
  it.each(["codex", "opencode"])("collapses an allow-every-builtin policy to the wildcard for %s", (sdk) => {
    expect(runtimeEnforcesToolPolicy(sdk)).toBe(false);
    const projected = projectToolPolicy({ sdk }, { allowedTools: ALL_BUILTINS, disallowedTools: [] });

    expect(projected.allowedTools).toEqual(["*"]);
    expect(projected.disallowedTools).toEqual([]);
    expect(projected.unenforceable).toBe(false);
  });

  it("leaves an already-wildcard policy alone", () => {
    const projected = projectToolPolicy({ sdk: "codex" }, { allowedTools: ["*"], disallowedTools: [] });
    expect(projected.allowedTools).toEqual(["*"]);
    expect(projected.unenforceable).toBe(false);
  });

  it("passes an absent policy through untouched", () => {
    const projected = projectToolPolicy({ sdk: "codex" }, {});
    expect(projected.allowedTools).toBeUndefined();
    expect(projected.disallowedTools).toBeUndefined();
    expect(projected.unenforceable).toBe(false);
  });

  it("flags a genuine subset as unenforceable instead of widening it", () => {
    const projected = projectToolPolicy({ sdk: "codex" }, { allowedTools: ["Read", "Grep"], disallowedTools: [] });

    // Never silently promote a restriction to allow-all — the run must fail.
    expect(projected.allowedTools).toEqual(["Read", "Grep"]);
    expect(projected.unenforceable).toBe(true);
  });

  it("flags a denylist as unenforceable even when everything is allowed", () => {
    const projected = projectToolPolicy(
      { sdk: "codex" },
      { allowedTools: ALL_BUILTINS, disallowedTools: ["Write"] },
    );

    expect(projected.disallowedTools).toEqual(["Write"]);
    expect(projected.unenforceable).toBe(true);
  });
});
