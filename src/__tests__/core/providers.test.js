import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations } from "../../core/db.js";
import {
  buildModelCapabilities,
  createVercelClient,
  createProvider,
  discoverModels,
  getProvider,
  isValidProviderType,
  isPrivateBaseUrl,
  listModels,
  resolveReasoningCapabilities,
  resolveVercelModel,
  setModelEnabled,
  testProvider,
  validateBaseUrl,
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
      reasoning_mode: "effort",
    });
    expect(buildModelCapabilities("openai_compat", "text-only", { tool_use: false, reasoning: false })).toMatchObject({
      supports_builtin_tools: false,
      builtin_tools: [],
      reasoning_mode: "none",
    });
  });
});
