import { describe, expect, it } from "vitest";

import * as agentRuntime from "@mono-agent/agent-runtime";

import { resolveModel } from "../../core/ai.js";

const REQUIRED_ACP_CONTROLS = [
  "probeAcpProfile",
  "authenticateAcpProfile",
  "logoutAcpProfile",
  "listAcpSessions",
  "deleteAcpSession",
  "validateAcpProviderSessionId",
];

describe("installed @mono-agent/agent-runtime ACP contract", () => {
  it("exports the high-level ACP control facade Worklab consumes", () => {
    for (const name of REQUIRED_ACP_CONTROLS) {
      expect(agentRuntime[name], name).toBeTypeOf("function");
    }
  });

  it("parses the canonical acp:<profile-id> model reference", () => {
    expect(resolveModel("acp:demo")).toEqual({
      sdk: "acp",
      model: "demo",
      reference: "acp:demo",
    });
  });
});
