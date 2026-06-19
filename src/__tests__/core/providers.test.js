import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import {
  buildModelCapabilities,
  createVercelClient,
  createProvider,
  discoverModels,
  getProvider,
  inferOpenCodeZenCapabilities,
  isOpenAICompatibleProviderType,
  isValidProviderType,
  isPrivateBaseUrl,
  listModels,
  refreshProviderStatus,
  resolveReasoningCapabilities,
  resolveVercelModel,
  setModelEnabled,
  testProvider,
  upsertModel,
  validateBaseUrl,
  ZEN_SEED_MODELS,
} from "../../core/providers.js";
import { _resetForTests } from "../../core/crypto.js";

let db;
let dataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-providers-"));
  db = openDb(":memory:");
  runMigrations(db);
  _resetForTests();
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  _resetForTests();
});

function insertLegacyProvider({ id = "legacy-provider", providerType = "anthropic_compat" } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO custom_providers
      (id, name, provider_type, base_url, trust_public_url, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, id, providerType, "http://localhost:8000", 0, 1, now, now);
  return id;
}

describe("providers", () => {
  it("does not accept unsupported Anthropic or Google provider types", () => {
    expect(isValidProviderType("anthropic_compat")).toBe(false);
    expect(isValidProviderType("google_compat")).toBe(false);
    expect(isValidProviderType("openai_compat")).toBe(true);
    expect(isValidProviderType("ollama")).toBe(true);
  });

  it("validates private and public base URLs", () => {
    expect(isPrivateBaseUrl("http://localhost:11434")).toBe(true);
    expect(isPrivateBaseUrl("http://100.64.1.2:11434")).toBe(true);
    expect(() => validateBaseUrl("http://api.example.com")).toThrow(/public host/i);
    expect(() => validateBaseUrl("http://api.example.com", { trustPublicUrl: true })).toThrow(/https/i);
    expect(() => validateBaseUrl("https://api.example.com", { trustPublicUrl: true })).not.toThrow();
  });

  it("encrypts API keys and only decrypts when requested", () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "local",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
      api_key: "sk-secret",
    });
    const row = db.prepare("SELECT api_key_encrypted FROM custom_providers WHERE id = ?").get(provider.id);
    expect(row.api_key_encrypted).toBeTruthy();
    expect(row.api_key_encrypted).not.toContain("sk-secret");
    expect(getProvider({ db, dataDir, id: provider.id, includeKey: false }).api_key).toBeUndefined();
    expect(getProvider({ db, dataDir, id: provider.id, includeKey: true }).api_key).toBe("sk-secret");
  });

  it("discovers OpenAI-compatible exact model IDs as disabled by default", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "compat",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    });
    const models = await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "llama-3.3-70b" }] }) }),
    });
    expect(models[0]).toMatchObject({ model_name: "llama-3.3-70b", enabled: false });
  });

  it("does not discover unsupported legacy provider rows as OpenAI-compatible", async () => {
    const providerId = insertLegacyProvider();
    const fetchImpl = vi.fn();

    await expect(discoverModels({ db, dataDir, providerId, fetchImpl }))
      .rejects.toThrow(/unsupported provider_type: anthropic_compat/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not test unsupported legacy provider rows as OpenAI-compatible", async () => {
    const providerId = insertLegacyProvider();
    const fetchImpl = vi.fn();

    const result = await testProvider({ db, dataDir, providerId, fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      url: null,
      error: "unsupported provider_type: anthropic_compat",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not create execution clients for unsupported provider types", () => {
    expect(() => createVercelClient({
      provider_type: "google_compat",
      base_url: "http://localhost:8000",
    })).toThrow(/unsupported provider_type: google_compat/);
  });

  it("preserves enabled model toggles across rediscovery", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "compat",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    });
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: "qwen2.5-coder:14b" }] }) });
    const [first] = await discoverModels({ db, dataDir, providerId: provider.id, fetchImpl });
    setModelEnabled({ db, id: first.id, enabled: true });
    await discoverModels({ db, dataDir, providerId: provider.id, fetchImpl });
    expect(listModels({ db, providerId: provider.id })[0]).toMatchObject({ model_name: "qwen2.5-coder:14b", enabled: true });
  });

  it("preserves manually entered pricing across rediscovery", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "compat",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    });
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: "priced-model" }] }) });
    const [first] = await discoverModels({ db, dataDir, providerId: provider.id, fetchImpl });
    upsertModel({
      db,
      providerId: provider.id,
      modelName: first.model_name,
      pricing: {
        input_per_million: 1,
        cached_input_per_million: 0.1,
        cache_write_per_million: 1.25,
        output_per_million: 5,
      },
    });

    await discoverModels({ db, dataDir, providerId: provider.id, fetchImpl });

    expect(listModels({ db, providerId: provider.id })[0].pricing).toMatchObject({
      input_per_million: 1,
      cached_input_per_million: 0.1,
      cache_write_per_million: 1.25,
      output_per_million: 5,
    });
  });

  it("persists failed provider status checks", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "ollama",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
    });

    const result = await refreshProviderStatus({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      timeoutMs: 25,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
    });
    const saved = getProvider({ db, dataDir, id: provider.id });
    expect(saved.status_checked_at).toEqual(expect.any(Number));
    expect(saved.status).toMatchObject({
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
    });
  });

  it("refreshes reachable providers and preserves enabled toggles and pricing during rediscovery", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "compat",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    });
    await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "priced-model" }] }) }),
    });
    const existing = listModels({ db, providerId: provider.id })[0];
    setModelEnabled({ db, id: existing.id, enabled: true });
    upsertModel({
      db,
      providerId: provider.id,
      modelName: existing.model_name,
      pricing: { input_per_million: 1, output_per_million: 5 },
    });

    const result = await refreshProviderStatus({
      db,
      dataDir,
      providerId: provider.id,
      discover: true,
      fetchImpl: vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ id: "priced-model" }, { id: "new-model" }] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ id: "priced-model" }, { id: "new-model" }] }) }),
    });

    expect(result).toMatchObject({ ok: true, status: 200, discovered: true, model_count: 2 });
    const saved = getProvider({ db, dataDir, id: provider.id });
    expect(saved.status).toMatchObject({ ok: true, status: 200 });
    expect(saved.status_checked_at).toEqual(expect.any(Number));
    expect(saved.last_discovered_at).toEqual(expect.any(Number));
    const models = listModels({ db, providerId: provider.id });
    expect(models.find((model) => model.model_name === "priced-model")).toMatchObject({
      enabled: true,
      pricing: { input_per_million: 1, output_per_million: 5 },
    });
    expect(models.find((model) => model.model_name === "new-model")).toBeTruthy();
  });

  it("keeps omitted pricing but clears explicitly empty pricing updates", () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "compat",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    });
    upsertModel({
      db,
      providerId: provider.id,
      modelName: "priced-model",
      pricing: {
        input_per_million: 1,
        output_per_million: 5,
      },
    });

    upsertModel({
      db,
      providerId: provider.id,
      modelName: "priced-model",
      displayName: "Priced model",
    });
    expect(listModels({ db, providerId: provider.id })[0].pricing).toMatchObject({
      input_per_million: 1,
      output_per_million: 5,
    });

    upsertModel({
      db,
      providerId: provider.id,
      modelName: "priced-model",
      pricing: {},
    });
    expect(listModels({ db, providerId: provider.id })[0].pricing).toEqual({});
  });

  it("rejects disabled models when resolving Vercel model references", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "compat",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    });
    await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }] }) }),
    });
    expect(() => resolveVercelModel({ db, dataDir, providerId: provider.id, modelName: "m1" })).toThrow(/model disabled/i);
  });

  it("resolves Ollama reasoning profiles into toggle vs effort modes", () => {
    expect(resolveReasoningCapabilities("ollama", "qwen2.5:7b", { reasoning: true })).toMatchObject({
      reasoning: true,
      reasoning_mode: "toggle",
    });
    expect(resolveReasoningCapabilities("ollama", "gpt-oss:20b", { reasoning: true })).toMatchObject({
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: ["low", "medium", "high"],
    });
  });

  it("adds builtin tool metadata to model capabilities", () => {
    expect(buildModelCapabilities("openai_compat", "deepseek-r1", { tool_use: true, reasoning: true })).toMatchObject({
      supports_builtin_tools: true,
      runnable_for_agent: true,
      reasoning_mode: "effort",
    });
    expect(buildModelCapabilities("openai_compat", "text-only", { tool_use: false, reasoning: false })).toMatchObject({
      supports_builtin_tools: false,
      builtin_tools: [],
      reasoning_mode: "none",
    });
  });

  it("marks embedding-only Ollama models as visible but not runnable for agents", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "ollama",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
    });
    const [model] = await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ models: [{ name: "nomic-embed-text:v1.5" }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: "nomic-embed-text:v1.5",
            details: { family: "nomic-bert", parameter_size: "137M" },
            capabilities: ["embedding"],
          }),
        }),
    });

    const capabilities = buildModelCapabilities(provider.provider_type, model.model_name, model.capabilities);
    expect(model.enabled).toBe(true);
    expect(capabilities).toMatchObject({
      runnable_for_agent: false,
      supports_builtin_tools: false,
      builtin_tools: [],
      embedding: true,
      chat: false,
    });
    expect(capabilities.unavailable_reason).toMatch(/embedding-only/i);
  });

  it("registers opencode-zen as an OpenAI-compatible provider type", () => {
    expect(isValidProviderType("opencode-zen")).toBe(true);
    expect(isOpenAICompatibleProviderType("opencode-zen")).toBe(true);
  });

  it("infers reasoning for OpenCode Zen GPT-5 models and falls back otherwise", () => {
    expect(inferOpenCodeZenCapabilities({ id: "gpt-5.1" })).toMatchObject({
      reasoning: true,
      reasoning_mode: "effort",
    });
    expect(inferOpenCodeZenCapabilities({ id: "gpt-4o-mini" })).toMatchObject({
      reasoning: false,
      reasoning_mode: "none",
    });
  });

  it("discovers OpenCode Zen models from /zen/v1/models with reasoning inference", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "zen",
      provider_type: "opencode-zen",
      base_url: "https://opencode.ai/zen/v1",
      trust_public_url: true,
    });
    let calledUrl = null;
    const models = await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async (url) => {
        calledUrl = url;
        return { ok: true, json: async () => ({ data: [{ id: "gpt-5.1" }] }) };
      },
    });
    expect(calledUrl).toBe("https://opencode.ai/zen/v1/models");
    expect(models[0]).toMatchObject({ model_name: "gpt-5.1" });
    expect(models[0].capabilities).toMatchObject({ reasoning: true, reasoning_mode: "effort" });
  });

  it("seeds curated OpenCode Zen models when discovery returns an empty list", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "zen",
      provider_type: "opencode-zen",
      base_url: "https://opencode.ai/zen/v1",
      trust_public_url: true,
    });
    const models = await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    });
    expect(models.length).toBe(ZEN_SEED_MODELS.length);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.model_name.startsWith("gpt-5"))).toBe(true);
  });

  it("seeds curated OpenCode Zen models when the discovery endpoint is missing (404)", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "zen",
      provider_type: "opencode-zen",
      base_url: "https://opencode.ai/zen/v1",
      trust_public_url: true,
    });
    const models = await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    expect(models.length).toBe(ZEN_SEED_MODELS.length);
  });

  it("treats OpenCode Zen auth failures as discovery errors instead of seeding", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "zen",
      provider_type: "opencode-zen",
      base_url: "https://opencode.ai/zen/v1",
      trust_public_url: true,
    });
    await expect(discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    })).rejects.toThrow(/401/);
    expect(listModels({ db, providerId: provider.id })).toHaveLength(0);
  });

  it("drops Anthropic models from OpenCode Zen discovery the runtime cannot call", async () => {
    const provider = createProvider({
      db,
      dataDir,
      name: "zen",
      provider_type: "opencode-zen",
      base_url: "https://opencode.ai/zen/v1",
      trust_public_url: true,
    });
    const models = await discoverModels({
      db,
      dataDir,
      providerId: provider.id,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "gpt-5.1" }, { id: "claude-opus-4" }] }),
      }),
    });
    const names = models.map((model) => model.model_name);
    expect(names).toContain("gpt-5.1");
    expect(names).not.toContain("claude-opus-4");
  });
});
