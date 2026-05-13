import { describe, expect, it } from "vitest";
import { validatePackMetadata } from "../../../scripts/validate-npm-pack.js";

describe("npm package content validation", () => {
  function pack(files, overrides = {}) {
    return {
      name: "@worklab-ai/worklab",
      files: files.map((path) => ({ path })),
      ...overrides,
    };
  }

  it("accepts the expected Worklab runtime package contents", () => {
    const issues = validatePackMetadata(pack([
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "src/cli/index.js",
      "src/core/config.js",
      "src/coordinator.js",
      "src/worker.js",
      "src/ui/dist/index.html",
      "data-template/agents/_seed/planner.json",
      "skills/worklab/SKILL.md",
    ]));

    expect(issues).toEqual([]);
  });

  it("rejects missing bundled UI and seed assets", () => {
    const issues = validatePackMetadata(pack([
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "src/cli/index.js",
    ]));

    expect(issues).toContain("missing required file: src/ui/dist/index.html");
    expect(issues).toContain("missing required file: data-template/agents/_seed/planner.json");
    expect(issues).toContain("missing required file: skills/worklab/SKILL.md");
  });

  it("rejects tests, source UI, workspace packages, and audit-only docs", () => {
    const issues = validatePackMetadata(pack([
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "src/cli/index.js",
      "src/core/config.js",
      "src/coordinator.js",
      "src/worker.js",
      "src/ui/dist/index.html",
      "data-template/agents/_seed/planner.json",
      "skills/worklab/SKILL.md",
      "src/__tests__/cli/help.test.js",
      "src/ui/src/main.jsx",
      "packages/agent-runtime/src/index.js",
      "docs/audits/ui-component-inventory.md",
    ]));

    expect(issues).toContain("forbidden package path: src/__tests__/cli/help.test.js");
    expect(issues).toContain("forbidden package path: src/ui/src/main.jsx");
    expect(issues).toContain("forbidden package path: packages/agent-runtime/src/index.js");
    expect(issues).toContain("forbidden package path: docs/audits/ui-component-inventory.md");
  });
});
