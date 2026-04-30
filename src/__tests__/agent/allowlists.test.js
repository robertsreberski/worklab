import { describe, expect, it } from "vitest";
import {
  inferAllowlistMode,
  normalizeList,
  resolveAllowlist,
  resolveAllowlistMap,
} from "../../agent/allowlists.js";

describe("agent allowlists", () => {
  it("normalizes and deduplicates selected names", () => {
    expect(normalizeList([" alpha ", "", "alpha", "beta", null])).toEqual(["alpha", "beta"]);
  });

  it("infers legacy empty lists as all unless the mode is explicit", () => {
    expect(inferAllowlistMode({ list: [] })).toBe("all");
    expect(inferAllowlistMode({ list: ["one"] })).toBe("custom");
    expect(inferAllowlistMode({ mode: "custom", list: [] })).toBe("custom");
  });

  it("resolves custom empty lists to none", () => {
    const items = [{ name: "one" }, { name: "two" }];
    expect(resolveAllowlist({ mode: "all", allowlist: [], all: items, getName: (item) => item.name })).toEqual(items);
    expect(resolveAllowlist({ mode: "custom", allowlist: [], all: items, getName: (item) => item.name })).toEqual([]);
  });

  it("resolves custom empty maps to none", () => {
    const all = { worklab: { command: "/bin/sh" }, github: { command: "/bin/sh" } };
    expect(Object.keys(resolveAllowlistMap({ mode: "all", allowlist: [], all }))).toEqual(["worklab", "github"]);
    expect(resolveAllowlistMap({ mode: "custom", allowlist: [], all })).toEqual({});
    expect(Object.keys(resolveAllowlistMap({ mode: "custom", allowlist: ["github"], all }))).toEqual(["github"]);
  });
});
