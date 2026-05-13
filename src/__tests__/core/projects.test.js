import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProjectWorkdir } from "../../core/projects.js";

describe("normalizeProjectWorkdir", () => {
  it("preserves absent and cleared workdirs", () => {
    expect(normalizeProjectWorkdir(undefined, "/fallback")).toBe("/fallback");
    expect(normalizeProjectWorkdir(null)).toBeNull();
    expect(normalizeProjectWorkdir("  ")).toBeNull();
  });

  it("expands home-relative project workdirs", () => {
    expect(normalizeProjectWorkdir("~/worklab-workspace/example-project"))
      .toBe(resolve(homedir(), "worklab-workspace/example-project"));
    expect(normalizeProjectWorkdir("~")).toBe(resolve(homedir()));
  });

  it("normalizes absolute project workdirs", () => {
    expect(normalizeProjectWorkdir("/tmp/../tmp/worklab-project"))
      .toBe("/tmp/worklab-project");
  });

  it("rejects relative project workdirs", () => {
    expect(() => normalizeProjectWorkdir("relative-mobile"))
      .toThrow("workdir must use an absolute path or ~/path");
    expect(() => normalizeProjectWorkdir("~other/path"))
      .toThrow("workdir must use an absolute path or ~/path");
  });
});
