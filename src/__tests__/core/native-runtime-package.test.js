import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { generateResponse } from "../../core/ai.js";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";

describe("installed native-subagent runtime contract", () => {
  it("passes provider-native discovery and helper controls through the real Claude runtime", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-native-runtime-"));
    const calls = [];
    try {
      const result = await generateResponse("system", {
        model: "claude:claude-sonnet-4-6",
        messages: [{ role: "user", content: "delegate if useful" }],
        cwd: dataDir,
        dataDir,
        settings: {},
        allowedTools: [...WORKLAB_BUILTIN_TOOLS],
        disallowedTools: [],
        claudeAgentQuery: (params) => {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "result",
                result: "ok",
                usage: {},
                duration_ms: 1,
                num_turns: 1,
              };
            },
            close: () => {},
          };
        },
      });

      expect(result.error).toBeFalsy();
      expect(result.text).toBe("ok");
      expect(calls).toHaveLength(1);
      expect(calls[0].options).toMatchObject({
        settingSources: ["user", "project", "local"],
        forwardSubagentText: true,
        allowedTools: expect.arrayContaining([
          "Agent",
          "Task",
          "TaskOutput",
          "TaskStop",
          "Skill",
        ]),
      });
      expect(calls[0].options).not.toHaveProperty("agents");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
