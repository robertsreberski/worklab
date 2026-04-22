import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations } from "../../core/db.js";
import {
  createProvider,
  discoverModels,
  getProvider,
  isPrivateBaseUrl,
  listModels,
  resolveVercelModel,
  setModelEnabled,
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

describe("providers", () => {
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
});
