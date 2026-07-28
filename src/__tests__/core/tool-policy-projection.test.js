import { describe, expect, it } from "vitest";
import { RUNTIME_CAPABILITIES } from "@mono-agent/agent-runtime/ai/runtime/registry.js";
import { projectToolPolicy, runtimeEnforcesToolPolicy } from "../../core/tool-policy-projection.js";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";

const ALL_BUILTINS = [...WORKLAB_BUILTIN_TOOLS];

// Drive the cases off the capability agent-runtime 0.15.2 advertises rather than
// a second hardcoded list — the point of mono-agent#549 was to stop Worklab
// maintaining its own copy of which bridges can project a tool policy.
const SDKS = Object.keys(RUNTIME_CAPABILITIES);
const PROJECTING = SDKS.filter((sdk) => RUNTIME_CAPABILITIES[sdk].tool_policy === "projected");
const ALLOW_ALL_ONLY = SDKS.filter((sdk) => RUNTIME_CAPABILITIES[sdk].tool_policy === "allow_all_only");

describe("projectToolPolicy", () => {
  it("covers every runtime the registry declares", () => {
    // Guards the two .each blocks below from silently testing nothing if the
    // capability is renamed or dropped upstream.
    expect(PROJECTING.length + ALLOW_ALL_ONLY.length).toBe(SDKS.length);
    expect(ALLOW_ALL_ONLY.length).toBeGreaterThan(0);
    expect(PROJECTING.length).toBeGreaterThan(0);
  });

  it.each(PROJECTING)("leaves the projecting runtime %s untouched", (sdk) => {
    expect(runtimeEnforcesToolPolicy(sdk)).toBe(true);
    const projected = projectToolPolicy({ sdk }, { allowedTools: ALL_BUILTINS, disallowedTools: [] });
    // Collapsing Claude to ["*"] would map onto allowedTools: undefined in the
    // SDK bridge, restoring its default toolset — wider than Worklab grants.
    expect(projected.allowedTools).toEqual(ALL_BUILTINS);
    expect(projected.unenforceable).toBe(false);
  });

  it("treats an unknown sdk as projecting", () => {
    expect(RUNTIME_CAPABILITIES["not-a-runtime"]).toBeUndefined();
    expect(runtimeEnforcesToolPolicy("not-a-runtime")).toBe(true);
  });

  // A named-only allowlist still fails closed on these routes in 0.15.2, so
  // Worklab has to express "no restriction" as the wildcard. Without this,
  // every codex run returned skipped_capability_mismatch /
  // codex_tool_policy_unsupported.
  it.each(ALLOW_ALL_ONLY)("collapses an allow-every-builtin policy to the wildcard for %s", (sdk) => {
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

  // 0.15.2 unified the allow-all sentinel on includes("*"), so a composed list
  // is allow-all too. 0.15.1 rejected this outright.
  it("passes a composed wildcard list through untouched", () => {
    const projected = projectToolPolicy({ sdk: "codex" }, { allowedTools: ["*", "Read"], disallowedTools: [] });

    expect(projected.allowedTools).toEqual(["*", "Read"]);
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
