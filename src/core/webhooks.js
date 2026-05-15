import { createRequire } from "node:module";
import { join } from "node:path";
import {
  normalizeInboundWebhookPayload,
  normalizeOptionalWebhookId,
  normalizeWebhookId,
} from "@worklab-ai/webhooks";

const require = createRequire(import.meta.url);

export function normalizeWorklabWebhookId(value) {
  return normalizeWebhookId(value);
}

export function normalizeWorklabOptionalWebhookId(value) {
  return normalizeOptionalWebhookId(value);
}

export function normalizeWorklabInboundWebhookPayload(options = {}) {
  return normalizeInboundWebhookPayload(options);
}

export function resolveBuiltinWebhookServerPath(repoRoot) {
  try {
    return require.resolve("@worklab-ai/webhooks/server");
  } catch {
    return join(repoRoot, "packages/webhooks/src/server.js");
  }
}

export function builtinWebhookMcpServer(repoRoot) {
  return {
    command: process.execPath,
    args: [resolveBuiltinWebhookServerPath(repoRoot)],
  };
}
