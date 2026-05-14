import { describe, expect, it, vi } from "vitest";

import {
  createWebhookToolHandlers,
  normalizeInboundWebhookPayload,
  normalizeWebhookId,
  newWebhookId,
  sendWebhook,
  webhookToolDefinitions,
} from "../index.js";

describe("@worklab-ai/webhooks", () => {
  it("generates URL-safe webhook ids and validates custom ids", () => {
    const generated = newWebhookId();

    expect(generated).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(normalizeWebhookId(" Custom_Id-123 ")).toBe("Custom_Id-123");
    expect(() => normalizeWebhookId("bad/id")).toThrow(/webhook id/i);
    expect(() => normalizeWebhookId("short")).toThrow(/webhook id/i);
  });

  it("normalizes JSON request bodies into bounded prompt previews", () => {
    const payload = normalizeInboundWebhookPayload({
      body: Buffer.from(JSON.stringify({ result: "ok", count: 2 })),
      headers: { "content-type": "application/json" },
      query: { source: "test" },
      receivedAt: "2026-05-14T12:00:00.000Z",
      maxPreviewChars: 12,
    });

    expect(payload).toMatchObject({
      content_type: "application/json",
      query: { source: "test" },
      received_at: "2026-05-14T12:00:00.000Z",
      body_kind: "json",
      body_bytes: 25,
      truncated: true,
    });
    expect(payload.body_preview).toContain("[truncated");
  });

  it("normalizes non-text request bodies without exposing binary data", () => {
    const payload = normalizeInboundWebhookPayload({
      body: Buffer.from([0, 1, 2, 3]),
      headers: { "content-type": "application/octet-stream" },
    });

    expect(payload).toMatchObject({
      content_type: "application/octet-stream",
      body_kind: "binary",
      body_bytes: 4,
      body_preview: "[binary payload omitted]",
      truncated: false,
    });
  });

  it("sends unauthenticated JSON POST requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("accepted", { status: 202, statusText: "Accepted" }));

    const result = await sendWebhook({
      url: "https://example.test/hook",
      data: { answer: 42 },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/hook", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "content-type": "application/json" }),
      body: JSON.stringify({ answer: 42 }),
    }));
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty("authorization");
    expect(result).toMatchObject({ ok: true, status: 202, response_preview: "accepted" });
  });

  it("exposes a trigger_webhook MCP-style handler", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const handlers = createWebhookToolHandlers({ fetchImpl });

    expect(webhookToolDefinitions.map((tool) => tool.name)).toEqual(["trigger_webhook"]);
    await expect(handlers.trigger_webhook({
      url: "https://example.test/result",
      data: { status: "done" },
    })).resolves.toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
