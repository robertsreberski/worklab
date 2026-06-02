import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/sdk", () => ({ createOpencode: vi.fn() }));

import { createOpencode } from "@opencode-ai/sdk";
import {
  opencodeAppRuntimeBridge,
  mapSpawnFailureKind,
  mapErrorFailureKind,
} from "../../ai/providers/opencode-app.js";

// Build a fake OpenCode client whose event stream yields `events` then ends,
// and whose session.prompt resolves with the given final message/parts.
function fakeOpencode({ events = [], promptParts = [], info = {}, sessionId = "sess-1", permissionRespond } = {}) {
  const close = vi.fn();
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
  const sessionPrompt = vi.fn().mockResolvedValue({ data: { info, parts: promptParts } });
  const sessionAbort = vi.fn().mockResolvedValue({ data: true });
  const subscribe = vi.fn().mockResolvedValue({
    stream: (async function* () {
      for (const ev of events) yield ev;
    })(),
  });
  const client = {
    session: { create: sessionCreate, prompt: sessionPrompt, abort: sessionAbort },
    event: { subscribe },
    postSessionIdPermissionsPermissionId: permissionRespond || vi.fn().mockResolvedValue({ data: true }),
  };
  createOpencode.mockResolvedValue({ client, server: { url: "http://127.0.0.1:0", close } });
  return { client, close, sessionCreate, sessionPrompt, sessionAbort, subscribe };
}

const baseInfo = {
  role: "assistant",
  cost: 0.0021,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } },
};

const partUpdated = (part) => ({ type: "message.part.updated", properties: { part } });
const idle = (sessionID = "sess-1") => ({ type: "session.idle", properties: { sessionID } });

beforeEach(() => createOpencode.mockReset());
afterEach(() => vi.clearAllMocks());

describe("opencode-app bridge", () => {
  it("supports only opencode sdk under cli execution mode", () => {
    expect(opencodeAppRuntimeBridge.supports({ sdk: "opencode" }, { executionMode: "cli" })).toBe(true);
    expect(opencodeAppRuntimeBridge.supports({ sdk: "opencode" }, { executionMode: "sdk" })).toBe(false);
    expect(opencodeAppRuntimeBridge.supports({ sdk: "codex" }, { executionMode: "cli" })).toBe(false);
  });

  it("runs a turn: normalizes tool events, captures final text + usage, closes the server", async () => {
    const harness = fakeOpencode({
      events: [
        partUpdated({ type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "ls" } }, sessionID: "sess-1" }),
        partUpdated({ type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file.txt" }, sessionID: "sess-1" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "final answer" }],
      info: baseInfo,
    });

    const onEvent = vi.fn();
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1", reference: "opencode:github-copilot:gpt-5.1" },
      messages: [{ role: "user", content: "do it" }],
      onEvent,
    });

    expect(result.sdk).toBe("opencode");
    expect(result.error).toBeNull();
    expect(result.failureKind).toBeNull();
    expect(result.text).toContain("final answer");
    expect(result.providerSessionId).toBe("sess-1");
    expect(result.model).toBe("opencode:github-copilot:gpt-5.1");
    // model routed to OpenCode provider/model
    expect(harness.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "sess-1" },
      body: expect.objectContaining({ model: { providerID: "github-copilot", modelID: "gpt-5.1" }, system: "SYSTEM" }),
    }));
    // tool_use + tool_result normalized onto the event stream
    const kinds = onEvent.mock.calls.map(([e]) => e.message?.content?.[0]?.type);
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    // usage + cost (OpenCode reports its own cost)
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 });
    expect(result.usage.cost_usd).toBe(0.0021);
    expect(harness.close).toHaveBeenCalled();
  });

  it("translates worklab MCP servers into OpenCode local/remote config", async () => {
    fakeOpencode({ events: [idle()], promptParts: [{ type: "text", text: "ok" }], info: baseInfo });
    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      mcpServers: {
        worklab: { command: "node", args: ["mcp.js"], env: { WORKLAB_DATA_DIR: "/d" } },
        remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    expect(createOpencode).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        mcp: {
          worklab: { type: "local", command: ["node", "mcp.js"], environment: { WORKLAB_DATA_DIR: "/d" }, enabled: true },
          remote: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, enabled: true },
        },
      }),
    }));
  });

  it("reuses a prior providerSessionId instead of creating a session", async () => {
    const harness = fakeOpencode({ events: [idle("resumed-1")], promptParts: [{ type: "text", text: "again" }], info: baseInfo, sessionId: "resumed-1" });
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      providerSessionId: "resumed-1",
    });
    expect(harness.sessionCreate).not.toHaveBeenCalled();
    expect(harness.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "resumed-1" } }));
    expect(result.providerSessionId).toBe("resumed-1");
  });

  it("forwards permission requests to onToolApprovalRequest and replies to OpenCode", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        { type: "permission.updated", properties: { id: "perm-1", type: "bash", sessionID: "sess-1", title: "Run ls", metadata: {} } },
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionRespond: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ approved: true });
    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest,
    });
    expect(onToolApprovalRequest).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "sess-1", permissionID: "perm-1" },
      body: { response: "once" },
    }));
  });

  it("classifies failure kinds", () => {
    expect(mapSpawnFailureKind({ code: "ENOENT", message: "opencode: command not found" })).toBe("spawn");
    expect(mapSpawnFailureKind({ message: "spawn opencode failed" })).toBe("spawn");
    expect(mapSpawnFailureKind({ message: "network blip" })).toBe("provider_unavailable");
    expect(mapErrorFailureKind({ name: "MessageAbortedError" })).toBe("cancelled");
    expect(mapErrorFailureKind({ name: "MessageOutputLengthError" })).toBe("usage_limit");
    expect(mapErrorFailureKind({ name: "ProviderAuthError" })).toBe("provider_unavailable");
  });

  it("surfaces an OpenCode error response as a failed run and still closes the server", async () => {
    const harness = fakeOpencode({ events: [idle()], promptParts: [], info: baseInfo });
    harness.sessionCreate.mockResolvedValue({ error: { name: "ProviderAuthError", message: "not logged in" } });
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.error).toMatch(/not logged in/);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(harness.close).toHaveBeenCalled();
  });
});
