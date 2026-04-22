import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { upsertModel } from "../../core/providers.js";
import { _resetForTests as resetCryptoCache } from "../../core/crypto.js";

const dirs = [];
function tmpDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "worklab-api-providers-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  resetCryptoCache();
});

describe("provider routes", () => {
  it("creates providers without returning API keys", async () => {
    const { agent } = makeTestServer({ dataDir: tmpDataDir() });
    const res = await agent.post("/api/providers").send({
      name: "local",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
      api_key: "sk-secret",
    }).expect(201);

    expect(res.body.provider).toMatchObject({ name: "local", has_api_key: true });
    expect(res.body.provider.api_key).toBeUndefined();
  });

  it("rejects untrusted public HTTP URLs", async () => {
    const { agent } = makeTestServer({ dataDir: tmpDataDir() });
    const res = await agent.post("/api/providers").send({
      name: "bad",
      provider_type: "openai_compat",
      base_url: "http://api.example.com",
    }).expect(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("lists explicit model catalogue groups", async () => {
    const { agent, db } = makeTestServer({ dataDir: tmpDataDir() });
    const p = await agent.post("/api/providers").send({
      name: "local",
      provider_type: "openai_compat",
      base_url: "http://localhost:8000",
    }).expect(201);
    const model = upsertModel({
      db,
      providerId: p.body.provider.id,
      modelName: "gemma3:4b",
      displayName: "gemma3:4b",
      enabled: true,
    });

    const res = await agent.get("/api/models/available").expect(200);
    expect(res.body.models.map((m) => m.value)).toContain("claude:claude-sonnet-4-6");
    expect(res.body.models.map((m) => m.value)).toContain("openai:gpt-5.4-mini");
    expect(res.body.models.map((m) => m.value)).toContain(`vercel:${p.body.provider.id}:${model.model_name}`);
    expect(res.body.models.find((m) => m.value === "claude:claude-sonnet-4-6").capabilities.reasoning_mode).toBe("effort");
    expect(res.body.models.find((m) => m.value === `vercel:${p.body.provider.id}:${model.model_name}`).supports_builtin_tools).toBe(true);
  });

  it("accepts curated hosted provider types", async () => {
    const { agent } = makeTestServer({ dataDir: tmpDataDir() });
    const res = await agent.post("/api/providers").send({
      name: "groq-prod",
      provider_type: "groq",
      base_url: "https://api.groq.com/openai",
      trust_public_url: true,
    }).expect(201);
    expect(res.body.provider.provider_type).toBe("groq");
  });

  // ── Encrypt/decrypt round-trip ─────────────────────────────────────────────

  describe("encrypt/decrypt round-trip", () => {
    it("stores an encrypted API key that differs from plaintext", async () => {
      const dataDir = tmpDataDir();
      const { agent, db } = makeTestServer({ dataDir });

      const res = await agent.post("/api/providers").send({
        name: "enc-test",
        provider_type: "openai_compat",
        base_url: "http://localhost:9000",
        api_key: "sk-plaintext-secret",
      }).expect(201);

      // Response must not echo the raw key
      expect(res.body.provider.api_key).toBeUndefined();
      expect(res.body.provider.has_api_key).toBe(true);

      // DB row must have encrypted column set and not equal to plaintext
      const row = db.prepare("SELECT * FROM custom_providers WHERE id = ?").get(res.body.provider.id);
      expect(row.api_key_encrypted).toBeTruthy();
      expect(row.api_key_encrypted).not.toBe("sk-plaintext-secret");
    });

    it("PATCH with a new api_key changes the stored ciphertext", async () => {
      const dataDir = tmpDataDir();
      const { agent, db } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "enc-patch",
        provider_type: "openai_compat",
        base_url: "http://localhost:9001",
        api_key: "sk-first-key",
      }).expect(201);

      const id = createRes.body.provider.id;
      const rowBefore = db.prepare("SELECT api_key_encrypted FROM custom_providers WHERE id = ?").get(id);

      await agent.patch(`/api/providers/${id}`).send({ api_key: "sk-second-key" }).expect(200);

      const rowAfter = db.prepare("SELECT api_key_encrypted FROM custom_providers WHERE id = ?").get(id);
      expect(rowAfter.api_key_encrypted).toBeTruthy();
      // Ciphertext must change (different plaintext + random IV guarantees this)
      expect(rowAfter.api_key_encrypted).not.toBe(rowBefore.api_key_encrypted);
    });

    it("PATCH clearing api_key removes the stored ciphertext", async () => {
      const dataDir = tmpDataDir();
      const { agent, db } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "enc-clear",
        provider_type: "openai_compat",
        base_url: "http://localhost:9002",
        api_key: "sk-to-clear",
      }).expect(201);

      const id = createRes.body.provider.id;

      const patchRes = await agent.patch(`/api/providers/${id}`).send({ api_key: "" }).expect(200);
      expect(patchRes.body.provider.has_api_key).toBe(false);

      const row = db.prepare("SELECT api_key_encrypted FROM custom_providers WHERE id = ?").get(id);
      expect(row.api_key_encrypted).toBeNull();
    });

    it("DELETE removes the provider row entirely", async () => {
      const dataDir = tmpDataDir();
      const { agent, db } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "enc-delete",
        provider_type: "openai_compat",
        base_url: "http://localhost:9003",
        api_key: "sk-will-delete",
      }).expect(201);

      const id = createRes.body.provider.id;
      await agent.delete(`/api/providers/${id}`).expect(204);

      const row = db.prepare("SELECT * FROM custom_providers WHERE id = ?").get(id);
      expect(row).toBeUndefined();
    });
  });

  // ── POST /:id/test ─────────────────────────────────────────────────────────

  describe("POST /api/providers/:id/test", () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns ok:true when the remote endpoint responds 200", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "test-happy",
        provider_type: "openai_compat",
        base_url: "http://localhost:11434",
      }).expect(201);

      const id = createRes.body.provider.id;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      }));

      const res = await agent.post(`/api/providers/${id}/test`).expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe(200);
      expect(typeof res.body.duration_ms).toBe("number");
    });

    it("returns ok:false when the remote endpoint responds 503", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "test-bad",
        provider_type: "openai_compat",
        base_url: "http://localhost:11435",
      }).expect(201);

      const id = createRes.body.provider.id;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }));

      const res = await agent.post(`/api/providers/${id}/test`).expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe(503);
    });

    it("returns ok:false with error message when fetch throws", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "test-unreachable",
        provider_type: "openai_compat",
        base_url: "http://localhost:11436",
      }).expect(201);

      const id = createRes.body.provider.id;

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const res = await agent.post(`/api/providers/${id}/test`).expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe(0);
      expect(res.body.error).toContain("ECONNREFUSED");
    });

    it("returns 404 for unknown provider id", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const res = await agent.post("/api/providers/nonexistent/test").expect(404);
      expect(res.body.error.code).toBe("not_found");
    });
  });

  // ── POST /:id/discover ─────────────────────────────────────────────────────

  describe("POST /api/providers/:id/discover", () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    it("discovers and upserts models for openai_compat providers", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "discover-compat",
        provider_type: "openai_compat",
        base_url: "http://localhost:12000",
      }).expect(201);

      const id = createRes.body.provider.id;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "llama3.2:3b", name: "llama3.2:3b" },
            { id: "gemma3:4b", name: "gemma3:4b" },
          ],
        }),
      }));

      const res = await agent.post(`/api/providers/${id}/discover`).expect(200);
      expect(Array.isArray(res.body.models)).toBe(true);
      expect(res.body.models.length).toBe(2);
      const names = res.body.models.map((m) => m.model_name);
      expect(names).toContain("llama3.2:3b");
      expect(names).toContain("gemma3:4b");
      // Each model must have a provider_id linking back to the provider
      for (const m of res.body.models) {
        expect(m.provider_id).toBe(id);
      }
    });

    it("discovers and upserts models for ollama providers", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "discover-ollama",
        provider_type: "ollama",
        base_url: "http://localhost:13000",
      }).expect(201);

      const id = createRes.body.provider.id;

      // ollama: first call is /api/tags, subsequent calls are /api/show (one per model)
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: "mistral:7b" }, { name: "phi3:mini" }],
          }),
        })
        // /api/show for mistral:7b
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ model: "mistral:7b", details: { family: "mistral", parameter_size: "7B" }, capabilities: ["tools"] }),
        })
        // /api/show for phi3:mini
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ model: "phi3:mini", details: { family: "phi", parameter_size: "3.8B" }, capabilities: [] }),
        }),
      );

      const res = await agent.post(`/api/providers/${id}/discover`).expect(200);
      expect(Array.isArray(res.body.models)).toBe(true);
      expect(res.body.models.length).toBe(2);
      const names = res.body.models.map((m) => m.model_name);
      expect(names).toContain("mistral:7b");
      expect(names).toContain("phi3:mini");
    });

    it("returns 502 with discovery_failed when fetch throws during discovery", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "discover-fail",
        provider_type: "openai_compat",
        base_url: "http://localhost:12001",
      }).expect(201);

      const id = createRes.body.provider.id;

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

      const res = await agent.post(`/api/providers/${id}/discover`).expect(502);
      expect(res.body.error.code).toBe("discovery_failed");
      expect(res.body.error.message).toContain("connection refused");
    });

    it("returns 502 with discovery_failed when remote returns non-ok status", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "discover-bad-status",
        provider_type: "openai_compat",
        base_url: "http://localhost:12002",
      }).expect(201);

      const id = createRes.body.provider.id;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      }));

      const res = await agent.post(`/api/providers/${id}/discover`).expect(502);
      expect(res.body.error.code).toBe("discovery_failed");
    });

    it("returns 404 for unknown provider id", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const res = await agent.post("/api/providers/nonexistent/discover").expect(404);
      expect(res.body.error.code).toBe("not_found");
    });
  });
});
