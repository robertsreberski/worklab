// Shared HTTP plumbing for the admin MCP tool wrappers. Used by every domain
// file under src/mcp/admin/tools/ to talk to the local Worklab REST API.

import { definedEntries, encodePath } from "./schema-helpers.js";

export async function apiRequest({ baseUrl, fetchImpl = fetch, token }, method, path, { query, body } = {}) {
  if (!path.startsWith("/api/")) throw new Error("path must start with /api/");
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(definedEntries(query))) {
    url.searchParams.set(key, String(value));
  }
  const headers = {};
  if (typeof token === "string" && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  // Internal API helpers must never turn a Worklab redirect into a
  // server-side request to an agent-controlled destination.
  const init = { method: method.toUpperCase(), headers, redirect: "manual" };
  if (body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  if (res.status === 204) return { ok: true, status: 204 };
  const text = await res.text();
  const parsed = text
    ? (() => {
        try { return JSON.parse(text); } catch { return { text }; }
      })()
    : {};
  if (!res.ok) {
    const message = parsed?.error?.message || parsed?.message || text || res.statusText;
    throw new Error(`${init.method} ${path} failed (${res.status}): ${message}`);
  }
  return parsed;
}

// Maps a request-body "kind" tag onto the actual body payload to send. The
// admin domain modules use small spec tuples (verb, path, queryKeys,
// bodyKind) to register their straightforward wrappers; this helper turns
// the bodyKind tag into the JSON body.
export function bodyFor(kind, input) {
  if (!kind) return undefined;
  if (kind === "input") return input;
  if (kind === "patch") return input.patch || {};
  if (kind === "mcpServers") return { mcpServers: input.mcpServers || {} };
  if (kind === "comment") return { body: input.body };
  if (kind === "members") return { members: input.members || [] };
  if (kind === "subtask") {
    const { id: _id, ...body } = input;
    return body;
  }
  if (kind === "skillPatch") return input.patch || {};
  return undefined;
}

// Builds a handler for one [name, method, path, queryKeys, bodyKind] spec
// tuple. The per-domain admin tool modules use this to declare simple
// wrappers without each repeating the apiRequest plumbing.
export function buildSpecHandler(client, spec) {
  const [, method, path, queryKeys = [], bodyKind] = spec;
  return async (input = {}) => apiRequest(client, method, encodePath(path, input), {
    query: Object.fromEntries(queryKeys.map((key) => [key, input[key]])),
    body: bodyFor(bodyKind, input),
  });
}

// Convenience for modules that declare an array of spec tuples and want a
// fully-built `{ toolName: handler }` map.
export function buildSpecHandlers(client, specs) {
  const handlers = {};
  for (const spec of specs) {
    handlers[spec[0]] = buildSpecHandler(client, spec);
  }
  return handlers;
}
