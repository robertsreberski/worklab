import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { generatePiResponse } from "../../core/ai-pi.js";
import { resolveModel } from "../../core/ai.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortedStream(message = "terminated", { code = null, requestId = null, reason = "aborted", stopReason = "aborted" } = {}) {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const error = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason,
        errorMessage: message,
        timestamp: Date.now(),
        ...(code ? { code } : {}),
        ...(requestId ? { requestId } : {}),
      };
      stream.push({ type: "error", reason, error });
    });
    return stream;
  };
}

describe("generatePiResponse cancellation handling", () => {
  it("treats provider/runtime aborts as provider errors when Worklab did not abort", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("terminated"),
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.cancelled).toBe(false);
    expect(result.error).toBe("terminated");
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.diagnostics).toMatchObject({
      pi_stop_reason: "aborted",
      external_abort: false,
    });
  });

  it("treats an already-aborted Worklab signal as cancellation, not provider failure", async () => {
    const ac = new AbortController();
    ac.abort();
    let streamCalled = false;

    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: () => {
        streamCalled = true;
        return abortedStream("unused")();
      },
      allowedTools: [],
      skills: [],
      mcpServers: {},
      abortSignal: ac.signal,
    });

    expect(streamCalled).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.failureKind).toBeNull();
    expect(result.diagnostics).toMatchObject({
      pi_stop_reason: "aborted",
      external_abort: true,
    });
  });

  it("captures pi_error_code from the stream error event", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("terminated", { code: "UND_ERR_SOCKET", requestId: "req_abc123" }),
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.cancelled).toBe(false);
    expect(result.error).toBe("terminated");
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.diagnostics).toMatchObject({
      pi_error_code: "UND_ERR_SOCKET",
      pi_request_id: "req_abc123",
    });
    expect(result.diagnostics.pi_error_payload).toMatchObject({
      error_message: "terminated",
      code: "UND_ERR_SOCKET",
      request_id: "req_abc123",
    });
  });
});
