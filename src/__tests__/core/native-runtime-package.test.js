import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { generateResponse } from "../../core/ai.js";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";
import { makeTestDb } from "../helpers/test-db.js";

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

describe("installed router runtime contract", () => {
  it("records a missing custom Pi fallback and continues to the next route", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-missing-pi-fallback-"));
    let claudeCalls = 0;
    const claudeAgentQuery = () => {
      const callIndex = claudeCalls;
      claudeCalls += 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (callIndex === 0) {
            yield {
              type: "result",
              subtype: "error_provider",
              is_error: true,
              error: { message: "network timeout" },
            };
            return;
          }
          yield {
            type: "result",
            result: "fallback ok",
            usage: {},
            duration_ms: 1,
            num_turns: 1,
          };
        },
        close: () => {},
      };
    };

    try {
      const result = await generateResponse("system", {
        db,
        dataDir,
        settings: {},
        model: "claude:claude-sonnet-4-6",
        fallbackChain: [
          { sdk: "pi", provider: "missing-provider", model: "missing-model" },
          { sdk: "claude", model: "claude-haiku-4-5-20251001" },
        ],
        messages: [{ role: "user", content: "continue if a route is unavailable" }],
        allowedTools: ["*"],
        disallowedTools: [],
        claudeAgentQuery,
      });

      expect(result).toMatchObject({
        text: "fallback ok",
        error: null,
        failureKind: null,
      });
      expect(claudeCalls).toBe(2);
      expect(result.failoverHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({
          model: { sdk: "pi", provider: "missing-provider", model: "missing-model" },
          failureKind: "safety_unavailable",
        }),
      ]));
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
