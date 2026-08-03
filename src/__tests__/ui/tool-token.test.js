import { describe, expect, it } from "vitest";

import { normalizeToolTokenEvent } from "../../ui/src/components/primitives/ToolToken.jsx";

function projectedTool({ result = null } = {}) {
  return {
    type: "assistant",
    source: "acp",
    _worklab_acp_projected: true,
    message: {
      content: [
        {
          type: "tool_use",
          id: "acp:tool:1",
          name: "Read agenda",
          input: { date: "today" },
        },
        ...(result ? [{
          type: "tool_result",
          tool_use_id: "acp:tool:1",
          content: result.content,
          is_error: result.isError === true,
        }] : []),
      ],
    },
  };
}

describe("ACP tool tokens", () => {
  it("keeps a running projected lifecycle tool-oriented", () => {
    expect(normalizeToolTokenEvent(projectedTool())).toMatchObject({
      type: "tool_use",
      name: "Read agenda",
      arg: "{\"date\":\"today\"}",
      status: "running",
    });
  });

  it("uses the paired result only to derive terminal status", () => {
    expect(normalizeToolTokenEvent(projectedTool({
      result: { content: "private result", isError: false },
    }))).toMatchObject({
      type: "tool_use",
      name: "Read agenda",
      status: "done",
    });
    expect(normalizeToolTokenEvent(projectedTool({
      result: { content: "failed", isError: true },
    }))).toMatchObject({
      type: "tool_use",
      name: "Read agenda",
      status: "error",
    });
  });
});
