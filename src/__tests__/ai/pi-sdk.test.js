import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { generatePiResponse } from "@worklab-ai/agent-runtime/ai/providers/pi-sdk.js";
import { resolveModel } from "../../core/ai.js";
import { createLiveInputQueue } from "../../core/live-input.js";
import { formatLiveInputGuidance } from "@worklab-ai/agent-runtime/ai/live-input-prompt.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortedStream(message = "terminated", { code = null, requestId = null, reason = "aborted", stopReason = "aborted", diagnostics = null } = {}) {
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
        ...(diagnostics ? { diagnostics } : {}),
      };
      stream.push({ type: "error", reason, error });
    });
    return stream;
  };
}

function assistantMessage(model, text, { stopReason = "stop" } = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function completeStream(text, { onDone } = {}) {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = assistantMessage(model, text);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
      onDone?.({ model, context });
    });
    return stream;
  };
}

function toolCallStream(name, args) {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const toolCall = { type: "toolCall", id: `${name}-1`, name, arguments: args };
      const message = {
        role: "assistant",
        content: [toolCall],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
    });
    return stream;
  };
}

describe("generatePiResponse cancellation handling", () => {
  afterEach(() => {
    delete process.env.WORKLAB_PROVIDER_SESSION_ID;
    delete process.env.WORKLAB_PI_CODEX_TRANSPORT;
  });

  it("treats provider/runtime aborts as provider errors when Worklab did not abort", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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

  it("adds stable diagnostics for generic WebSocket provider errors", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("WebSocket error", { reason: "error", stopReason: "error" }),
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.cancelled).toBe(false);
    expect(result.error).toBe("WebSocket error");
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.errorDetails).toMatchObject({
      pi_stop_reason: "error",
      pi_error_code: "websocket_error",
      pi_transport: "sse",
    });
    expect(result.diagnostics).toMatchObject({
      pi_stop_reason: "error",
      pi_error_code: "websocket_error",
      pi_transport: "sse",
    });
  });

  it("returns the reusable provider session id used by the Pi agent", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("terminated"),
      allowedTools: [],
      skills: [],
      mcpServers: {},
      providerSessionId: "pi-session-prev",
    });

    expect(result.providerSessionId).toBe("pi-session-prev");
    expect(result.diagnostics.provider_session_id).toBe("pi-session-prev");
  });
});

describe("generatePiResponse Codex transport", () => {
  afterEach(() => {
    delete process.env.WORKLAB_PI_CODEX_TRANSPORT;
  });

  it("uses SSE for Pi OpenAI Codex by default", async () => {
    let streamOptions = null;
    const streamFn = (model, context, options) => {
      streamOptions = options;
      return completeStream("done")(model, context);
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.error).toBeNull();
    expect(streamOptions).toMatchObject({ transport: "sse" });
    expect(result.diagnostics.pi_transport).toBe("sse");
  });

  it("keeps non-Codex Pi providers on the Pi transport default", async () => {
    let streamOptions = null;
    const streamFn = (model, context, options) => {
      streamOptions = options;
      return completeStream("done")(model, context);
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.error).toBeNull();
    expect(streamOptions).toMatchObject({ transport: "auto" });
    expect(result.diagnostics.pi_transport).toBe("auto");
  });

  it("allows an explicit Codex transport override for debugging", async () => {
    let streamOptions = null;
    const streamFn = (model, context, options) => {
      streamOptions = options;
      return completeStream("done")(model, context);
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      allowedTools: [],
      skills: [],
      mcpServers: {},
      piCodexTransport: "websocket-cached",
    });

    expect(result.error).toBeNull();
    expect(streamOptions).toMatchObject({ transport: "websocket-cached" });
    expect(result.diagnostics.pi_transport).toBe("websocket-cached");
  });

  it("adds upstream WebSocket diagnostics when cached WebSocket fails", async () => {
    const transportDiagnostic = {
      type: "provider_transport_failure",
      timestamp: 123,
      error: { name: "Error", message: "WebSocket error" },
      details: {
        configuredTransport: "websocket-cached",
        phase: "after_message_stream_start",
        eventsEmitted: true,
        requestBytes: 1234,
      },
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: abortedStream("WebSocket error", {
        reason: "error",
        stopReason: "error",
        diagnostics: [transportDiagnostic],
      }),
      allowedTools: [],
      skills: [],
      mcpServers: {},
      providerSessionId: "pi-session-ws",
      piCodexTransport: "websocket-cached",
    });

    expect(result.error).toBe("WebSocket error");
    expect(result.diagnostics.pi_transport_failure).toMatchObject({
      type: "provider_transport_failure",
      error_message: "WebSocket error",
      configured_transport: "websocket-cached",
      phase: "after_message_stream_start",
      events_emitted: true,
      request_bytes: 1234,
    });
    expect(result.errorDetails.pi_transport_failure).toMatchObject({
      error_message: "WebSocket error",
      configured_transport: "websocket-cached",
    });
  });
});

describe("generatePiResponse structured output finalization", () => {
  const outputSchema = {
    type: "object",
    properties: {
      schema: { type: "string" },
      summary: { type: "string" },
    },
    required: ["schema", "summary"],
    additionalProperties: false,
  };

  it("retries once in-session when Pi stops with no text or structured result", async () => {
    const contexts = [];
    let streamCount = 0;
    const structured = { schema: "worklab.v2", summary: "Done" };
    const streamFn = (model, context) => {
      streamCount += 1;
      contexts.push(context);
      if (streamCount === 1) return completeStream("")(model, context);
      return toolCallStream("StructuredOutput", structured)(model, context);
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      allowedTools: ["Bash"],
      skills: [],
      mcpServers: {},
      outputSchema,
    });

    expect(streamCount).toBe(2);
    expect(contexts[1].tools.map((tool) => tool.name)).toEqual(["StructuredOutput"]);
    expect(result.error).toBeNull();
    expect(result.structuredResult).toEqual(structured);
    expect(result.structuredResultSource).toBe("StructuredOutput");
    expect(result.runtimeWarnings).toContainEqual(expect.objectContaining({
      warning_kind: "structured_output_finalization_retry",
      reason: "empty_final_output",
    }));
    expect(result.diagnostics).toMatchObject({
      structured_output_finalization_retry_attempts: 1,
      structured_output_finalization_retry_reason: "empty_final_output",
      structured_output_finalization_retry_failed: false,
      last_tool_name: "StructuredOutput",
    });
  });

  it("keeps diagnostics when the structured output finalization retry also returns nothing", async () => {
    const contexts = [];
    let streamCount = 0;
    const streamFn = (model, context) => {
      streamCount += 1;
      contexts.push(context);
      return completeStream("")(model, context);
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      allowedTools: ["Bash"],
      skills: [],
      mcpServers: {},
      outputSchema,
    });

    expect(streamCount).toBe(2);
    expect(contexts[1].tools.map((tool) => tool.name)).toEqual(["StructuredOutput"]);
    expect(result.error).toBeNull();
    expect(result.structuredResult).toBeUndefined();
    expect(result.runtimeWarnings).toContainEqual(expect.objectContaining({
      warning_kind: "structured_output_finalization_retry",
      reason: "empty_final_output",
    }));
    expect(result.diagnostics).toMatchObject({
      structured_output_finalization_retry_attempts: 1,
      structured_output_finalization_retry_reason: "empty_final_output",
      structured_output_finalization_retry_failed: true,
    });
  });
});

describe("generatePiResponse live input", () => {
  it("continues with live input that arrives just after the first assistant response", async () => {
    const liveInput = createLiveInputQueue();
    const contexts = [];
    let streamCount = 0;
    const streamFn = (model, context) => {
      streamCount += 1;
      contexts.push(context);
      return completeStream(streamCount === 1 ? "Initial answer" : "Guided answer", {
        onDone: () => {
          if (streamCount === 1) {
            liveInput.push({ id: "live-1", body: "Please narrow this to the API route.", createdAt: 123 });
          }
        },
      })(model, context);
    };

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      liveInput,
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });
    liveInput.close();

    expect(result.error).toBeNull();
    expect(streamCount).toBe(2);
    expect(contexts[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: formatLiveInputGuidance("Please narrow this to the API route."),
      }),
    ]));
    expect(result.text).toBe("Guided answer");
  });
});

describe("generatePiResponse native subagents", () => {
  it("exposes AskAgent and runs a nested Pi agent for the selected teammate", async () => {
    const contexts = [];
    let parentTurns = 0;
    const streamFn = (model, context) => {
      contexts.push(context);
      if (context.systemPrompt.includes("You are helper.")) {
        return completeStream("helper inspected the router")(model, context);
      }
      parentTurns += 1;
      if (parentTurns === 1) {
        return toolCallStream("AskAgent", { agent: "helper", prompt: "Inspect the router." })(model, context);
      }
      return completeStream("parent finished")(model, context);
    };

    const result = await generatePiResponse("parent sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn,
      allowedTools: [],
      skills: [],
      mcpServers: {},
      nativeSubagents: {
        provider: "pi",
        mode: "advisory",
        maxParallelChildren: 1,
        teammates: [{
          name: "helper",
          description: "Reads focused code paths.",
          helperSystemPrompt: "You are helper.",
          model: resolveModel("pi:openai:gpt-5.4-mini"),
          effort: "medium",
          allowedTools: [],
          skills: [],
          skillDirs: [],
          mcpServers: {},
          toolPolicy: { bashReadOnly: true },
        }],
      },
    });

    expect(result.error).toBeNull();
    expect(result.text).toBe("parent finished");
    expect(parentTurns).toBe(2);
    expect(contexts.some((context) => context.systemPrompt === "You are helper.")).toBe(true);
    expect(result.events).toContainEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "AskAgent-1", name: "AskAgent", input: { agent: "helper", prompt: "Inspect the router." } }] },
    });
    const toolResult = result.events.find((event) => event?.message?.content?.[0]?.tool_use_id === "AskAgent-1");
    expect(toolResult?.message.content[0].content).toContain("helper inspected the router");
    expect(result.diagnostics.pi_subagents).toMatchObject({ count: 1, errors: 0 });
  });
});

describe("generatePiResponse error details", () => {
  it("includes errorDetails on the result when the stream errors mid-turn", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
      model: resolveModel("pi:openai-codex:gpt-5.5"),
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
