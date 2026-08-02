import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("production import boundaries", () => {
  it("bans direct Pi imports in core DB modules without banning their DB driver", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText([
      'import Database from "better-sqlite3";',
      'import { getModels } from "@earendil-works/pi-ai";',
      "void Database;",
      "void getModels;",
    ].join("\n"), {
      filePath: resolve(repoRoot, "src/core/db/pi-import-probe.js"),
    });
    const restrictedImports = result.messages.filter((message) => message.ruleId === "no-restricted-imports");

    expect(restrictedImports).toHaveLength(1);
    expect(restrictedImports[0].message).toContain("@mono-agent/agent-runtime/ai");
    expect(restrictedImports[0].message).toContain("pi-ai is a test-only dependency");
  });
});
