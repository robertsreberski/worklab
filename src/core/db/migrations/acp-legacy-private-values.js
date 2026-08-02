import { validateAcpProviderSessionId } from "../../acp-privacy.js";
import {
  normalizeAcpPaginationCursorKey,
  parseAcpSessionCursor,
} from "../../acp-session-cursors.js";

const MAX_PRIVATE_VALUES = 4_096;
const MAX_PRIVATE_VALUE_CHARS = 16 * 1024;
const MAX_PRIVATE_SOURCE_CHARS = 16 * 1024 * 1024;
const EXPLICIT_PRIVATE_VALUE_RE = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;

function parseJson(value) {
  try {
    return { value: JSON.parse(value), valid: true };
  } catch {
    return { value: null, valid: false };
  }
}

function decodedProviderSessionSeed(value) {
  if (typeof value !== "string") return null;
  const match = /^acp:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u.exec(value);
  if (!match || !validateAcpProviderSessionId(value, match[1])) return null;
  try {
    const bytes = Buffer.from(match[2], "base64url");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.length > 0
      && bytes.toString("base64url") === match[2]
      && decoded
      && decoded.trim() === decoded
      && !decoded.includes("\0")
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function addGlobalPrivateValue(values, candidate, { cursor = false, provider = false } = {}) {
  if (candidate == null || candidate === "" || typeof candidate !== "string") return;
  const value = cursor
    ? (parseAcpSessionCursor(candidate)?.rawValue ?? candidate)
    : provider
      ? (decodedProviderSessionSeed(candidate) ?? candidate)
      : candidate;
  if (!value || values.has(value)) return;
  if (value.length > MAX_PRIVATE_VALUE_CHARS) {
    throw new Error("ACP privacy migration exceeded the private-value size limit");
  }
  if (values.size >= MAX_PRIVATE_VALUES) {
    throw new Error("ACP privacy migration exceeded the private-value count limit");
  }
  values.add(value);
}

export function collectPrivateValuesFromObject(value, values, {
  includeCursors = false,
  parentKey = "",
  depth = 0,
  nodes = { value: 0 },
} = {}) {
  if (depth > 32 || nodes.value > 50_000) {
    throw new Error("ACP privacy migration exceeded the private-value traversal limit");
  }
  nodes.value += 1;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPrivateValuesFromObject(entry, values, {
        includeCursors,
        parentKey,
        depth: depth + 1,
        nodes,
      });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "sessionId" || key === "session_id") addGlobalPrivateValue(values, entry);
    if (key === "providerSessionId" || key === "provider_session_id") {
      addGlobalPrivateValue(values, entry, { provider: true });
    }
    if (parentKey === "sessions" && key === "id") addGlobalPrivateValue(values, entry, { provider: true });
    if (includeCursors && normalizeAcpPaginationCursorKey(key)) {
      addGlobalPrivateValue(values, entry, { cursor: true });
    }
    collectPrivateValuesFromObject(entry, values, {
      includeCursors,
      parentKey: key,
      depth: depth + 1,
      nodes,
    });
  }
}

export function collectPrivateValuesFromText(text, values, { includeCursors = false } = {}) {
  if (text == null) return;
  const serialized = String(text);
  if (serialized.length > MAX_PRIVATE_SOURCE_CHARS) {
    throw new Error("ACP privacy migration exceeded the private-value source limit");
  }
  for (const match of serialized.matchAll(EXPLICIT_PRIVATE_VALUE_RE)) {
    try {
      const key = JSON.parse(`"${match[1]}"`);
      const value = JSON.parse(`"${match[2]}"`);
      if (key === "sessionId" || key === "session_id") addGlobalPrivateValue(values, value);
      if (key === "providerSessionId" || key === "provider_session_id") {
        addGlobalPrivateValue(values, value, { provider: true });
      }
      if (includeCursors && normalizeAcpPaginationCursorKey(key)) {
        addGlobalPrivateValue(values, value, { cursor: true });
      }
    } catch {
      // The owning ACP JSON value is replaced by its existing fail-closed path.
    }
  }
  const parsed = parseJson(text);
  if (parsed.valid) collectPrivateValuesFromObject(parsed.value, values, { includeCursors });
}

function mergePrivateValues(target, values) {
  for (const value of values) target.add(value);
}

export function createPrivateValueScope() {
  return {
    all: new Set(),
    byProfile: new Map(),
    byRun: new Map(),
    byTask: new Map(),
  };
}

export function addOwnedPrivateValues(scope, values, { profileId, runId, taskId } = {}) {
  mergePrivateValues(scope.all, values);
  for (const [map, key] of [
    [scope.byProfile, profileId],
    [scope.byRun, runId],
    [scope.byTask, taskId],
  ]) {
    if (!key) continue;
    if (!map.has(key)) map.set(key, new Set());
    mergePrivateValues(map.get(key), values);
  }
}

export function finalizePrivateValueScope(scope) {
  const sorted = (values) => [...values].sort((left, right) => right.length - left.length);
  return {
    all: sorted(scope.all),
    byProfile: new Map([...scope.byProfile].map(([key, values]) => [key, sorted(values)])),
    byRun: new Map([...scope.byRun].map(([key, values]) => [key, sorted(values)])),
    byTask: new Map([...scope.byTask].map(([key, values]) => [key, sorted(values)])),
  };
}
