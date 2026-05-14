import { randomBytes } from "node:crypto";

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const DEFAULT_PREVIEW_CHARS = 4000;
const DEFAULT_RESPONSE_PREVIEW_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 15000;
const TEXTUAL_TYPES = [
  "application/json",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/yaml",
  "application/ld+json",
];

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return "";
}

function contentTypeBase(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function isTextualContentType(contentType) {
  const base = contentTypeBase(contentType);
  return base.startsWith("text/") || TEXTUAL_TYPES.includes(base) || base.endsWith("+json") || base.endsWith("+xml");
}

function truncateText(text, maxChars, label = "payload") {
  const value = String(text || "");
  const limit = Math.max(0, Number(maxChars) || DEFAULT_PREVIEW_CHARS);
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }
  const marker = `\n[truncated ${label} from ${value.length} to ${limit} characters]`;
  const sliceLength = Math.max(0, limit - marker.length);
  return { text: `${value.slice(0, sliceLength)}${marker}`, truncated: true };
}

function safeQuery(query) {
  if (!query || typeof query !== "object") return {};
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.map((item) => String(item)) : String(value)]),
  );
}

export function newWebhookId() {
  return randomBytes(24).toString("base64url");
}

export function normalizeWebhookId(value) {
  const id = String(value || "").trim();
  if (!WEBHOOK_ID_RE.test(id)) {
    throw new Error("webhook id must be 8-128 URL-safe characters: letters, numbers, underscore, or dash");
  }
  return id;
}

export function normalizeOptionalWebhookId(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? normalizeWebhookId(trimmed) : newWebhookId();
}

export function normalizeInboundWebhookPayload({
  body,
  headers = {},
  query = {},
  receivedAt = new Date().toISOString(),
  maxPreviewChars = DEFAULT_PREVIEW_CHARS,
} = {}) {
  const buffer = Buffer.isBuffer(body)
    ? body
    : body == null
      ? Buffer.alloc(0)
      : Buffer.from(typeof body === "string" ? body : String(body));
  const contentType = headerValue(headers, "content-type") || "application/octet-stream";
  const bodyBytes = buffer.byteLength;

  if (!bodyBytes) {
    return {
      received_at: receivedAt,
      content_type: contentType,
      query: safeQuery(query),
      body_kind: "empty",
      body_bytes: 0,
      body_preview: "",
      truncated: false,
    };
  }

  const text = buffer.toString("utf8");
  const baseType = contentTypeBase(contentType);
  if (baseType === "application/json" || baseType.endsWith("+json")) {
    const parsed = (() => {
      try { return JSON.parse(text); } catch { return null; }
    })();
    const previewSource = parsed === null ? text : JSON.stringify(parsed, null, 2);
    const preview = truncateText(previewSource, maxPreviewChars);
    return {
      received_at: receivedAt,
      content_type: contentType,
      query: safeQuery(query),
      body_kind: parsed === null ? "text" : "json",
      body_bytes: bodyBytes,
      body_preview: preview.text,
      truncated: preview.truncated,
    };
  }

  if (isTextualContentType(contentType)) {
    const preview = truncateText(text, maxPreviewChars);
    return {
      received_at: receivedAt,
      content_type: contentType,
      query: safeQuery(query),
      body_kind: "text",
      body_bytes: bodyBytes,
      body_preview: preview.text,
      truncated: preview.truncated,
    };
  }

  return {
    received_at: receivedAt,
    content_type: contentType,
    query: safeQuery(query),
    body_kind: "binary",
    body_bytes: bodyBytes,
    body_preview: "[binary payload omitted]",
    truncated: false,
  };
}

export async function sendWebhook({
  url,
  data = null,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responsePreviewChars = DEFAULT_RESPONSE_PREVIEW_CHARS,
} = {}) {
  if (!url || typeof url !== "string") throw new Error("url is required");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("webhook url must be http or https");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "worklab-webhooks",
      },
      body: JSON.stringify(data ?? {}),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    const preview = truncateText(text, responsePreviewChars, "webhook response");
    return {
      ok: !!response.ok,
      status: response.status,
      status_text: response.statusText || "",
      response_preview: preview.text,
      response_truncated: preview.truncated,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const webhookToolDefinitions = [
  {
    name: "trigger_webhook",
    description: "Trigger an unauthenticated webhook URL with JSON data. Use this when instructions say to trigger a webhook with the run result.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Webhook URL to POST to." },
        data: { description: "JSON-serializable payload to send to the webhook." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export function createWebhookToolHandlers({ fetchImpl = fetch } = {}) {
  return {
    trigger_webhook: async ({ url, data } = {}) => sendWebhook({ url, data, fetchImpl }),
  };
}
