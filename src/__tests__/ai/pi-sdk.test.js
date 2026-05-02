import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { generatePiResponse } from "../../ai/providers/pi-sdk.js";
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
  afterEach(() => {
    delete process.env.WORKLAB_PROVIDER_SESSION_ID;
  });

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

  it("returns the reusable provider session id used by the Pi agent", async () => {
    process.env.WORKLAB_PROVIDER_SESSION_ID = "pi-session-prev";

    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("terminated"),
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.providerSessionId).toBe("pi-session-prev");
    expect(result.diagnostics.provider_session_id).toBe("pi-session-prev");
  });
});

describe("generatePiResponse error details", () => {
  it("includes errorDetails on the result when the stream errors mid-turn", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("terminated", { code: "UND_ERR_SOCKET", requestId: "req_x" }),
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.errorDetails).toMatchObject({
      pi_stop_reason: "aborted",
      pi_error_code: "UND_ERR_SOCKET",
      pi_request_id: "req_x",
      had_partial_progress: false,
      tool_results_seen: 0,
      max_turns_hit: false,
    });
    expect(result.errorDetails.last_text_excerpt).toBeNull();
    expect(result.errorDetails.last_tool_name).toBeNull();
  });

  it("captures last_text_excerpt from streamed text deltas before an error", async () => {
    const partialText = "Working on the analysis of the failing test before it terminated";
    const streamWithText = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: "aborted",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: partialText, partial });
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            ...partial,
            errorMessage: "terminated",
          },
        });
      });
      return stream;
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: streamWithText,
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.errorDetails).toBeTruthy();
    expect(result.errorDetails.last_text_excerpt).toContain("Working on the analysis");
    expect(result.errorDetails.had_partial_progress).toBe(true);
    expect(result.errorDetails.pi_stop_reason).toBe("aborted");
  });

  it("caps last_text_excerpt at 200 chars (keeps the tail)", async () => {
    const longTail = "TAIL_MARKER_AT_END";
    const longText = "x".repeat(400) + longTail;
    const streamWithLongText = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = {
          role: "assistant",
          content: [{ type: "text", text: longText }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: "aborted",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: longText, partial });
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...partial, errorMessage: "terminated" },
        });
      });
      return stream;
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: streamWithLongText,
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.errorDetails.last_text_excerpt.length).toBeLessThanOrEqual(200);
    expect(result.errorDetails.last_text_excerpt).toContain(longTail);
  });

  it("populates errorDetails when the stream surfaces an error with a network code", async () => {
    const partialText = "Partial assistant text before connection died";
    const erroringStream = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: "error",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: partialText, partial });
        stream.push({
          type: "error",
          reason: "error",
          error: { ...partial, stopReason: "error", errorMessage: "socket hang up", code: "ECONNRESET" },
        });
      });
      return stream;
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: erroringStream,
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.error).toBeTruthy();
    expect(result.errorDetails).toBeTruthy();
    expect(result.errorDetails.pi_error_code).toBe("ECONNRESET");
    expect(result.errorDetails.last_text_excerpt).toContain("Partial assistant text");
    expect(result.errorDetails.had_partial_progress).toBe(true);
    expect(result.errorDetails.pi_stop_reason).toBe("error");
  });

  it("returns null errorDetails when the run is cancelled by an external abort", async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await generatePiResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("ignored"),
      allowedTools: [],
      skills: [],
      mcpServers: {},
      abortSignal: ac.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.errorDetails ?? null).toBeNull();
  });
});
