import net from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama as createAiSdkOllama } from "ai-sdk-ollama";
import { encrypt, decrypt } from "./crypto.js";
import { newProviderId, newModelId } from "./ids.js";
import { WORKLAB_BUILTIN_TOOLS } from "./ai.js";

export const PROVIDER_TYPES = [
  "ollama",
  "lmstudio",
  "vllm",
  "openai_compat",
  "groq",
  "openrouter",
  "together",
  "fireworks",
  "deepseek",
];

export const OPENAI_COMPAT_PROVIDER_TYPES = [
  "lmstudio",
  "vllm",
  "openai_compat",
  "groq",
  "openrouter",
  "together",
  "fireworks",
  "deepseek",
];

const OPENAI_COMPAT_PROVIDER_TYPE_SET = new Set(OPENAI_COMPAT_PROVIDER_TYPES);
const OPENAI_COMPAT_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const OLLAMA_EFFORT_REASONING_HINTS = ["gpt-oss"];
const OLLAMA_EFFORT_REASONING_LEVELS = ["low", "medium", "high"];
const OLLAMA_TOGGLE_REASONING_HINTS = ["deepseek", "qwen", "qwq", "thinking", "reasoning"];
const AGENT_CHAT_CAPABILITIES = new Set(["chat", "completion", "tools", "thinking", "reasoning", "vision"]);

const PRIVATE_HOSTNAMES = new Set(["localhost", "host.docker.internal"]);
const PRIVATE_V4_CIDRS = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
];

function ipToLong(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) + n;
  }
  return acc >>> 0;
}

function inCidrV4(ip, cidr, bits) {
  const ipLong = ipToLong(ip);
  const cidrLong = ipToLong(cidr);
  if (ipLong === null || cidrLong === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipLong & mask) === (cidrLong & mask);
}

export function isValidProviderType(type) {
  return PROVIDER_TYPES.includes(type);
}

export function isOpenAICompatibleProviderType(type) {
  return OPENAI_COMPAT_PROVIDER_TYPE_SET.has(type);
}

function unsupportedProviderTypeError(provider) {
  return new Error(`unsupported provider_type: ${provider.provider_type}`);
}

export function isPrivateBaseUrl(url) {
  if (typeof url !== "string") return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  const family = net.isIP(host);
  if (family === 4) return PRIVATE_V4_CIDRS.some(([cidr, bits]) => inCidrV4(host, cidr, bits));
  if (family === 6) {
    const h = host.replace(/%.*$/, "");
    if (h === "::1") return true;
    const first = parseInt(h.split(":")[0] || "0", 16);
    if (Number.isNaN(first)) return false;
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
  }
  return false;
}

export function validateBaseUrl(url, { trustPublicUrl = false } = {}) {
  if (!url || typeof url !== "string") throw new Error("base_url required");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`base_url is not a valid URL: ${url}`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("base_url must use http(s)://");
  if (isPrivateBaseUrl(url)) return;
  if (!trustPublicUrl) throw new Error("base_url points to a public host; set trust_public_url=true to allow it");
  if (parsed.protocol !== "https:") throw new Error("public base_url must use https://");
}

function rowToProvider(row, { includeKey = false, dataDir } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    name: row.name,
    provider_type: row.provider_type,
    base_url: row.base_url,
    trust_public_url: !!row.trust_public_url,
    enabled: row.enabled !== 0,
    has_api_key: !!row.api_key_encrypted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includeKey && row.api_key_encrypted) {
    try {
      out.api_key = decrypt(row.api_key_encrypted, { dataDir });
    } catch (err) {
      out.api_key = null;
      out.api_key_error = err.message;
    }
  }
  return out;
}

function rowToModel(row) {
  if (!row) return null;
  let capabilities = {};
  let pricing = {};
  try { capabilities = row.capabilities_json ? JSON.parse(row.capabilities_json) : {}; } catch { capabilities = {}; }
  try { pricing = row.pricing_json ? JSON.parse(row.pricing_json) : {}; } catch { pricing = {}; }
  return {
    id: row.id,
    provider_id: row.provider_id,
    model_name: row.model_name,
    alias: row.alias || null,
    display_name: row.display_name || row.alias || row.model_name,
    capabilities,
    pricing,
    enabled: !!row.enabled,
    created_at: row.created_at,
    discovered_at: row.discovered_at || row.created_at,
  };
}

export function listProviders({ db, enabledOnly = false, includeKeys = false, dataDir } = {}) {
  const sql = enabledOnly
    ? "SELECT * FROM custom_providers WHERE enabled = 1 ORDER BY name"
    : "SELECT * FROM custom_providers ORDER BY name";
  return db.prepare(sql).all().map((row) => rowToProvider(row, { includeKey: includeKeys, dataDir }));
}

export function getProvider({ db, id, includeKey = false, dataDir }) {
  return rowToProvider(db.prepare("SELECT * FROM custom_providers WHERE id = ?").get(id), { includeKey, dataDir });
}

export function createProvider({ db, dataDir, name, provider_type, base_url, api_key = null, trust_public_url = false, enabled = true }) {
  if (!name || typeof name !== "string") throw new Error("name required");
  if (!isValidProviderType(provider_type)) throw new Error(`invalid provider_type: ${provider_type}`);
  validateBaseUrl(base_url, { trustPublicUrl: trust_public_url });
  const now = Date.now();
  const id = newProviderId();
  db.prepare(`
    INSERT INTO custom_providers
      (id, name, provider_type, base_url, api_key_encrypted, trust_public_url, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    provider_type,
    base_url.trim(),
    api_key ? encrypt(api_key, { dataDir }) : null,
    trust_public_url ? 1 : 0,
    enabled ? 1 : 0,
    now,
    now,
  );
  return getProvider({ db, id, includeKey: false, dataDir });
}

export function updateProvider({ db, dataDir, id, patch = {} }) {
  const existing = getProvider({ db, id, includeKey: false, dataDir });
  if (!existing) throw new Error("provider not found");
  if (patch.provider_type !== undefined && !isValidProviderType(patch.provider_type)) {
    throw new Error(`invalid provider_type: ${patch.provider_type}`);
  }
  if (patch.base_url !== undefined || patch.trust_public_url !== undefined) {
    validateBaseUrl(patch.base_url ?? existing.base_url, {
      trustPublicUrl: patch.trust_public_url ?? existing.trust_public_url,
    });
  }

  const fields = [];
  const values = [];
  for (const [column, value] of [
    ["name", patch.name],
    ["provider_type", patch.provider_type],
    ["base_url", patch.base_url],
  ]) {
    if (value !== undefined) { fields.push(`${column} = ?`); values.push(String(value).trim()); }
  }
  if (patch.trust_public_url !== undefined) { fields.push("trust_public_url = ?"); values.push(patch.trust_public_url ? 1 : 0); }
  if (patch.enabled !== undefined) { fields.push("enabled = ?"); values.push(patch.enabled ? 1 : 0); }
  if (patch.api_key !== undefined) {
    fields.push("api_key_encrypted = ?");
    values.push(patch.api_key ? encrypt(patch.api_key, { dataDir }) : null);
  }
  if (fields.length === 0) return existing;
  fields.push("updated_at = ?");
  values.push(Date.now(), id);
  db.prepare(`UPDATE custom_providers SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getProvider({ db, id, includeKey: false, dataDir });
}

export function deleteProvider({ db, id }) {
  return db.prepare("DELETE FROM custom_providers WHERE id = ?").run(id).changes > 0;
}

export function listModels({ db, providerId = null, enabledOnly = false } = {}) {
  const where = [];
  const args = [];
  if (providerId) { where.push("provider_id = ?"); args.push(providerId); }
  if (enabledOnly) where.push("enabled = 1");
  const sql = `SELECT * FROM custom_models ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY display_name, model_name`;
  return db.prepare(sql).all(...args).map(rowToModel);
}

export function getModel({ db, id }) {
  return rowToModel(db.prepare("SELECT * FROM custom_models WHERE id = ?").get(id));
}

export function getModelByProviderAndName({ db, providerId, modelName }) {
  return rowToModel(db.prepare("SELECT * FROM custom_models WHERE provider_id = ? AND model_name = ?").get(providerId, modelName));
}

export function upsertModel({ db, providerId, modelName, displayName, alias, capabilities = {}, pricing = {}, enabled }) {
  const existing = getModelByProviderAndName({ db, providerId, modelName });
  const now = Date.now();
  const caps = JSON.stringify(capabilities || {});
  const price = JSON.stringify(pricing || {});
  if (existing) {
    db.prepare(`
      UPDATE custom_models
      SET display_name = ?, alias = ?, capabilities_json = ?, pricing_json = ?, discovered_at = ?
          ${enabled !== undefined ? ", enabled = ?" : ""}
      WHERE id = ?
    `).run(
      displayName || existing.display_name || modelName,
      alias ?? existing.alias,
      caps,
      price,
      now,
      ...(enabled !== undefined ? [enabled ? 1 : 0] : []),
      existing.id,
    );
    return getModel({ db, id: existing.id });
  }
  const id = newModelId();
  db.prepare(`
    INSERT INTO custom_models
      (id, provider_id, model_name, alias, display_name, capabilities_json, pricing_json, enabled, created_at, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, providerId, modelName, alias || null, displayName || alias || modelName, caps, price, enabled ? 1 : 0, now, now);
  return getModel({ db, id });
}

export function setModelEnabled({ db, id, enabled }) {
  db.prepare("UPDATE custom_models SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  return getModel({ db, id });
}

export function inferOllamaReasoningProfile({ modelName = "", family = "", advertisedCapabilities = new Set() } = {}) {
  const haystack = `${modelName} ${family}`.toLowerCase();
  const advertisedThinking = advertisedCapabilities.has("thinking") || advertisedCapabilities.has("reasoning");
  if (OLLAMA_EFFORT_REASONING_HINTS.some((hint) => haystack.includes(hint))) {
    return {
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: [...OLLAMA_EFFORT_REASONING_LEVELS],
      reasoning_disable_supported: false,
    };
  }
  const toggleReasoning = advertisedThinking || OLLAMA_TOGGLE_REASONING_HINTS.some((hint) => haystack.includes(hint));
  if (!toggleReasoning) {
    return {
      reasoning: false,
      reasoning_mode: "none",
    };
  }
  return {
    reasoning: true,
    reasoning_mode: "toggle",
    reasoning_disable_supported: true,
  };
}

export function resolveReasoningCapabilities(providerType, modelName, capabilities = {}) {
  const next = { ...(capabilities || {}) };
  if (providerType === "ollama") {
    const fallback = inferOllamaReasoningProfile({
      modelName,
      family: next.family || "",
      advertisedCapabilities: new Set(Array.isArray(next.advertised_capabilities) ? next.advertised_capabilities : []),
    });
    const reasoningMode = next.reasoning_mode || (next.reasoning === false ? "none" : fallback.reasoning_mode);
    return {
      ...next,
      reasoning: next.reasoning ?? (reasoningMode !== "none"),
      reasoning_mode: reasoningMode,
      reasoning_levels: reasoningMode === "effort"
        ? Array.isArray(next.reasoning_levels) && next.reasoning_levels.length > 0
          ? next.reasoning_levels
          : [...OLLAMA_EFFORT_REASONING_LEVELS]
        : undefined,
      reasoning_disable_supported: reasoningMode === "none"
        ? undefined
        : (next.reasoning_disable_supported ?? fallback.reasoning_disable_supported ?? true),
    };
  }
  if (!next.reasoning) {
    return {
      ...next,
      reasoning: false,
      reasoning_mode: "none",
      reasoning_levels: undefined,
      reasoning_disable_supported: undefined,
    };
  }
  return {
    ...next,
    reasoning: true,
    reasoning_mode: next.reasoning_mode || "effort",
    reasoning_levels: Array.isArray(next.reasoning_levels) && next.reasoning_levels.length > 0
      ? next.reasoning_levels
      : [...OPENAI_COMPAT_REASONING_LEVELS],
    reasoning_disable_supported: next.reasoning_disable_supported ?? true,
  };
}

function advertisedCapabilities(capabilities = {}) {
  return new Set(Array.isArray(capabilities.advertised_capabilities)
    ? capabilities.advertised_capabilities.map((value) => String(value).toLowerCase())
    : []);
}

export function resolveAgentRunnableStatus(capabilities = {}) {
  const advertised = advertisedCapabilities(capabilities);
  if (advertised.size > 0) {
    const hasChat = [...AGENT_CHAT_CAPABILITIES].some((capability) => advertised.has(capability));
    if (!hasChat) {
      if (advertised.has("embedding")) {
        return { runnable_for_agent: false, unavailable_reason: "Embedding-only model; use it for knowledge/search settings, not agent chat." };
      }
      return { runnable_for_agent: false, unavailable_reason: "This model did not advertise chat or completion support." };
    }
  }

  if (capabilities.runnable_for_agent === false || capabilities.chat === false || capabilities.completion === false) {
    return { runnable_for_agent: false, unavailable_reason: capabilities.unavailable_reason || "Not runnable for agent chat." };
  }

  return { runnable_for_agent: true, unavailable_reason: null };
}

export function buildModelCapabilities(providerType, modelName, capabilities = {}) {
  const normalized = resolveReasoningCapabilities(providerType, modelName, capabilities);
  const runnable = resolveAgentRunnableStatus(normalized);
  const supportsBuiltinTools = runnable.runnable_for_agent && normalized.tool_use !== false;
  return {
    ...normalized,
    ...runnable,
    builtin_tools: supportsBuiltinTools ? [...WORKLAB_BUILTIN_TOOLS] : [],
    supports_builtin_tools: supportsBuiltinTools,
  };
}

function rootUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
}

function modelsUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function authHeaders(provider) {
  return provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {};
}

async function fetchOllamaShow(provider, modelName, fetchImpl) {
  try {
    const resp = await fetchImpl(`${rootUrl(provider.base_url)}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(provider) },
      body: JSON.stringify({ model: modelName }),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function inferOllamaCapabilities(model, show = null) {
  const details = show?.details || model?.details || {};
  const caps = new Set(Array.isArray(show?.capabilities) ? show.capabilities.map((v) => String(v).toLowerCase()) : []);
  const name = String(show?.model || model?.name || "").toLowerCase();
  const family = `${details.family || ""} ${(details.families || []).join(" ")}`.toLowerCase();
  const hasChat = caps.size > 0 ? caps.has("completion") || caps.has("chat") : true;
  const reasoningProfile = inferOllamaReasoningProfile({
    modelName: show?.model || model?.name || "",
    family,
    advertisedCapabilities: caps,
  });
  return {
    tool_use: hasChat && (caps.size > 0 ? caps.has("tools") : /llama|mistral|qwen|gemma|phi|granite/.test(family)),
    reasoning: hasChat && reasoningProfile.reasoning,
    reasoning_mode: reasoningProfile.reasoning_mode,
    reasoning_levels: reasoningProfile.reasoning_levels,
    reasoning_disable_supported: reasoningProfile.reasoning_disable_supported,
    vision: hasChat && (caps.has("vision") || /vision|llava|multimodal/.test(`${name} ${family}`)),
    json_mode: hasChat,
    embedding: caps.has("embedding"),
    chat: hasChat,
    parameter_size: details.parameter_size || null,
    family,
    advertised_capabilities: [...caps],
  };
}

function inferOpenAICompatCapabilities(model) {
  const id = String(model.id || model.name || "").toLowerCase();
  const embedding = /embed|embedding/i.test(id);
  const reasoning = !embedding && /o1|o3|o4|deepseek-r|qwq|thinking|reasoning/.test(id);
  return {
    tool_use: !embedding && (model.tool_use ?? true),
    reasoning,
    reasoning_mode: reasoning ? "effort" : "none",
    reasoning_levels: reasoning ? [...OPENAI_COMPAT_REASONING_LEVELS] : undefined,
    reasoning_disable_supported: reasoning ? true : undefined,
    vision: !embedding && (model.vision ?? /vision|vl|multimodal|gpt-4o/.test(id)),
    json_mode: !embedding && (model.json_mode ?? true),
    embedding,
    chat: !embedding,
  };
}

export async function discoverModels({ db, dataDir, providerId, fetchImpl = fetch }) {
  const provider = getProvider({ db, id: providerId, includeKey: true, dataDir });
  if (!provider) throw new Error("provider not found");
  const discovered = [];

  if (provider.provider_type === "ollama") {
    const resp = await fetchImpl(`${rootUrl(provider.base_url)}/api/tags`, { headers: authHeaders(provider) });
    if (!resp.ok) throw new Error(`ollama /api/tags returned ${resp.status}`);
    const data = await resp.json();
    for (const model of Array.isArray(data.models) ? data.models : []) {
      const show = await fetchOllamaShow(provider, model.name, fetchImpl);
      discovered.push({
        modelName: model.name,
        displayName: model.name,
        capabilities: inferOllamaCapabilities(model, show),
      });
    }
  } else if (isOpenAICompatibleProviderType(provider.provider_type)) {
    const resp = await fetchImpl(modelsUrl(provider.base_url), { headers: authHeaders(provider) });
    if (!resp.ok) throw new Error(`/v1/models returned ${resp.status}`);
    const data = await resp.json();
    for (const model of Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []) {
      const modelName = model.id || model.name;
      if (!modelName) continue;
      discovered.push({
        modelName,
        displayName: model.name || model.id,
        capabilities: inferOpenAICompatCapabilities(model),
      });
    }
  } else {
    throw unsupportedProviderTypeError(provider);
  }

  return discovered.map((model) => upsertModel({
    db,
    providerId: provider.id,
    modelName: model.modelName,
    displayName: model.displayName,
    capabilities: model.capabilities,
    enabled: undefined,
  }));
}

export async function testProvider({ db, dataDir, providerId, fetchImpl = fetch }) {
  const provider = getProvider({ db, id: providerId, includeKey: true, dataDir });
  if (!provider) throw new Error("provider not found");
  let url = null;
  const start = Date.now();
  try {
    if (provider.provider_type === "ollama") {
      url = `${rootUrl(provider.base_url)}/api/tags`;
    } else if (isOpenAICompatibleProviderType(provider.provider_type)) {
      url = modelsUrl(provider.base_url);
    } else {
      throw unsupportedProviderTypeError(provider);
    }
    const resp = await fetchImpl(url, { headers: authHeaders(provider) });
    return { ok: resp.ok, status: resp.status, duration_ms: Date.now() - start, url };
  } catch (err) {
    return { ok: false, status: 0, duration_ms: Date.now() - start, url, error: err.message };
  }
}

export function defaultOllamaNumCtx(parameterSize) {
  if (!parameterSize) return 16384;
  const match = String(parameterSize).trim().match(/^([\d.]+)\s*([bm])?$/i);
  if (!match) return 16384;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n)) return 16384;
  const billions = match[2]?.toLowerCase() === "m" ? n / 1000 : n;
  if (billions >= 14) return 32768;
  if (billions >= 4) return 16384;
  return 8192;
}

export function createVercelClient(provider, { modelName = "", capabilities = {} } = {}) {
  const baseUrl = provider.base_url.replace(/\/+$/, "");
  if (provider.provider_type === "ollama") {
    const root = rootUrl(baseUrl);
    const resolved = resolveReasoningCapabilities(provider.provider_type, modelName, capabilities);
    if (resolved.reasoning_mode === "effort") {
      const compat = createOpenAICompatible({ name: "ollama", baseURL: `${root}/v1`, apiKey: provider.api_key || "ollama" });
      return (nextModelName) => compat.chatModel(nextModelName);
    }
    const ollama = createAiSdkOllama({ baseURL: root, ...(provider.api_key ? { apiKey: provider.api_key } : {}) });
    return (nextModelName, settings = {}) => ollama.chat(nextModelName, settings);
  }
  if (!isOpenAICompatibleProviderType(provider.provider_type)) {
    throw unsupportedProviderTypeError(provider);
  }
  const compat = createOpenAICompatible({
    name: provider.provider_type,
    baseURL: /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`,
    apiKey: provider.api_key || "ollama",
  });
  return (nextModelName) => compat.chatModel(nextModelName);
}

export function resolveVercelModel({ db, dataDir, providerId, modelName }) {
  const provider = getProvider({ db, id: providerId, includeKey: true, dataDir });
  if (!provider) throw new Error(`provider not found: ${providerId}`);
  if (!provider.enabled) throw new Error(`provider disabled: ${providerId}`);
  const modelRow = getModelByProviderAndName({ db, providerId, modelName });
  if (modelRow && !modelRow.enabled) throw new Error(`model disabled: ${modelName}`);
  const capabilities = resolveReasoningCapabilities(provider.provider_type, modelName, modelRow?.capabilities || {});
  const modelFactory = createVercelClient(provider, { modelName, capabilities });
  return { provider, modelRow: modelRow ? { ...modelRow, capabilities } : modelRow, modelFactory, capabilities };
}
