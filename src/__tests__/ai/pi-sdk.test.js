import { describe, expect, it } from "vitest";
import { createRouterRuntime } from "@mono-agent/agent-runtime";
import { generatePiNativeResponse as generatePiResponse } from "@mono-agent/agent-runtime/ai";
import { resolveModel } from "../../core/ai.js";
import { createLiveInputQueue, formatLiveInputGuidance } from "../../core/live-input.js";

describe("Pi runtime dependency surface", () => {
  it("uses the mono runtime native Pi bridge from the public AI surface", () => {
    expect(generatePiResponse).toBeTypeOf("function");
  });

  it("treats an already-aborted Worklab signal as cancellation before credentials are needed", async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      allowedTools: [],
      skills: [],
      mcpServers: {},
      abortSignal: ac.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.failureKind).toBeNull();
    expect(result.diagnostics).toMatchObject({
      pi_stop_reason: "aborted",
      external_abort: true,
    });
  });

  it("surfaces missing Pi credentials as a provider auth failure", async () => {
    const result = await generatePiResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      allowedTools: [],
      skills: [],
      mcpServers: {},
      resolvePiApiKey: () => null,
    });

    expect(result.cancelled).toBe(false);
    // Pi 0.83 changed the human message; the runtime must keep the stable
    // provider_auth classification Worklab and its fallback router consume.
    expect(result.error).toMatch(/(?:No API key for provider|Provider is not configured): openai-codex/);
    expect(result.failureKind).toBe("provider_auth");
  });

  it("advances a two-route chain when the first Pi provider is not configured", async () => {
    const first = resolveModel("pi:openai-codex:gpt-5.5");
    const second = resolveModel("pi:openai:gpt-5.5");
    const runtime = createRouterRuntime({
      host: { resolvePiApiKey: () => null },
      chain: [first, second],
    });

    const result = await runtime.run("sys", {
      model: first,
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      allowedTools: [],
      skills: [],
      mcpServers: {},
    });

    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory).toEqual([
      expect.objectContaining({ model: first, failureKind: "provider_auth" }),
      expect.objectContaining({ model: second, failureKind: "provider_auth" }),
    ]);
  });
});

describe("Worklab live input helpers", () => {
  it("normalizes queued live input bodies", async () => {
    const queue = createLiveInputQueue();
    queue.push({ body: "Please narrow the scope." });
    queue.close();

    await expect(queue.next()).resolves.toMatchObject({
      done: false,
      value: { body: "Please narrow the scope." },
    });
    await expect(queue.next()).resolves.toMatchObject({ done: true });
  });

  it("exposes the shared live-input guidance prompt", () => {
    expect(formatLiveInputGuidance("Please narrow the scope.")).toContain("Keep satisfying the original task");
  });
});
