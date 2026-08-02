import { describe, expect, it } from "vitest";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";
import { projectToolPolicy } from "../../core/tool-policy-projection.js";

describe("WORKLAB_BUILTIN_TOOLS", () => {
  // Regression guard for the defect this list caused: Worklab always sends a
  // named `allowedTools` array, agent-runtime turns it into `--tools <csv>`, and
  // Claude Code hard-limits itself to that list. Dropping the subagent tool
  // therefore disabled every on-disk `.claude/agents` profile with no error and
  // no warning — the tool simply did not exist for the model.
  it("grants both exact subagent tool names used by the supported runtimes", () => {
    expect(WORKLAB_BUILTIN_TOOLS).toContain("Agent");
    expect(WORKLAB_BUILTIN_TOOLS).toContain("Task");
  });

  it("grants the native skill tool", () => {
    expect(WORKLAB_BUILTIN_TOOLS).toContain("Skill");
  });

  // Worklab owns run todos through core/run-todos.js and the agent MCP surface.
  // The native tool would keep a second list nothing reads.
  it("does not grant the native todo tool", () => {
    expect(WORKLAB_BUILTIN_TOOLS).not.toContain("TodoWrite");
  });

  it("has no duplicate entries", () => {
    expect(new Set(WORKLAB_BUILTIN_TOOLS).size).toBe(WORKLAB_BUILTIN_TOOLS.length);
  });

  it("keeps the allow-all ceiling curated", () => {
    expect(WORKLAB_BUILTIN_TOOLS).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "Agent",
      "Task",
      "Skill",
      "SlashCommand",
      "NotebookEdit",
      "BashOutput",
      "KillShell",
    ]);
  });

  // `coversEveryBuiltin` compares against this exact list, so a widened list must
  // still collapse to the wildcard Codex understands. If it did not, every
  // allow-all Codex run would start failing `codex_tool_policy_unsupported`.
  it("still collapses to the codex wildcard when every entry is granted", () => {
    const projected = projectToolPolicy({ sdk: "codex" }, {
      allowedTools: [...WORKLAB_BUILTIN_TOOLS],
      disallowedTools: [],
    });
    expect(projected.allowedTools).toEqual(["*"]);
    expect(projected.unenforceable).toBe(false);
  });
});
