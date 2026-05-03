import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModels as getPiModels } from "@mariozechner/pi-ai";
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
    for (const piModel of getPiModels("openai")) {
      expect(res.body.models.map((m) => m.value)).toContain(`pi:openai:${piModel.id}`);
    }
    for (const piModel of getPiModels("openai-codex")) {
      expect(res.body.models.map((m) => m.value)).toContain(`pi:openai-codex:${piModel.id}`);
    }
    expect(res.body.models.map((m) => m.value)).toContain(`pi:${p.body.provider.id}:${model.model_name}`);
    expect(res.body.groups.find((g) => g.id === "pi:openai-codex").label).toBe("OpenAI Codex");
    expect(res.body.models.find((m) => m.value === "claude:claude-sonnet-4-6").capabilities.reasoning_mode).toBe("effort");
    expect(typeof res.body.models.find((m) => m.value === "claude:claude-sonnet-4-6").disabled).toBe("boolean");
    expect(res.body.models.find((m) => m.value === "pi:openai-codex:gpt-5.5").supports_builtin_tools).toBe(true);
    expect(res.body.models.some((m) => m.value === "pi:google:gemini-2.5-pro")).toBe(true);
    expect(res.body.models.find((m) => m.value === `pi:${p.body.provider.id}:${model.model_name}`).supports_builtin_tools).toBe(true);
  });

  it("does not advertise reserved runtime prefixes for agent models", async () => {
    const { agent } = makeTestServer({ dataDir: tmpDataDir() });
    const res = await agent.get("/api/models/available").expect(200);
    const reserved = ["codex:", "openai:", "vercel:", "claude-code:"];
    for (const model of res.body.models) {
      expect(reserved.some((prefix) => String(model.value).startsWith(prefix))).toBe(false);
    }
  });

  it("omits enabled non-runnable custom models from the agent model catalogue", async () => {
    const { agent, db } = makeTestServer({ dataDir: tmpDataDir() });
    const p = await agent.post("/api/providers").send({
      name: "ollama",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
    }).expect(201);
    upsertModel({
      db,
      providerId: p.body.provider.id,
      modelName: "nomic-embed-text:v1.5",
      displayName: "nomic-embed-text:v1.5",
      capabilities: { advertised_capabilities: ["embedding"], embedding: true, chat: false },
      enabled: true,
    });

    const res = await agent.get("/api/models/available").expect(200);
    expect(res.body.models.map((m) => m.value)).not.toContain(`pi:${p.body.provider.id}:nomic-embed-text:v1.5`);
  });

  it("omits saved models from unsupported legacy provider types", async () => {
    const { agent, db } = makeTestServer({ dataDir: tmpDataDir() });
    const now = Date.now();
    db.prepare(`
      INSERT INTO custom_providers
        (id, name, provider_type, base_url, trust_public_url, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy", "legacy", "anthropic_compat", "http://localhost:8000", 0, 1, now, now);
    upsertModel({
      db,
      providerId: "legacy",
      modelName: "claude-compatible",
      displayName: "claude-compatible",
      enabled: true,
    });

    const res = await agent.get("/api/models/available").expect(200);
    expect(res.body.models.map((m) => m.value)).not.toContain("pi:legacy:claude-compatible");
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

  it("rejects unsupported Anthropic and Google provider types", async () => {
    const { agent } = makeTestServer({ dataDir: tmpDataDir() });
    for (const provider_type of ["anthropic_compat", "google_compat"]) {
      const res = await agent.post("/api/providers").send({
        name: provider_type,
        provider_type,
        base_url: "http://localhost:8000",
      }).expect(400);
      expect(res.body.error.code).toBe("validation");
    }
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

  describe("PATCH /api/providers/:id/models/:modelId", () => {
    it("discovers embedding-only models as enabled without adding them to the agent model catalogue", async () => {
      const dataDir = tmpDataDir();
      const { agent } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      }).expect(201);

      const id = createRes.body.provider.id;
      const tagsResponse = () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: "nomic-embed-text:v1.5" }] }),
      });
      const showResponse = () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "nomic-embed-text:v1.5",
          details: { family: "nomic-bert", parameter_size: "137M" },
          capabilities: ["embedding"],
        }),
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(tagsResponse())
        .mockResolvedValueOnce(showResponse());
      vi.stubGlobal("fetch", fetchMock);

      const discovered = await agent.post(`/api/providers/${id}/discover`).expect(200);
      const model = discovered.body.models[0];
      expect(model.capabilities.runnable_for_agent).toBe(false);
      expect(model.enabled).toBe(true);

      const res = await agent.patch(`/api/providers/${id}/models/${model.id}`).send({ enabled: true }).expect(200);
      expect(res.body.model.enabled).toBe(true);

      const agentModels = await agent.get("/api/models/available").expect(200);
      expect(agentModels.body.models.map((m) => m.value)).not.toContain(`pi:${id}:nomic-embed-text:v1.5`);

      const embeddingModels = await agent.get("/api/models/embeddings").expect(200);
      expect(embeddingModels.body.groups.flatMap((group) => group.models).map((m) => m.value))
        .toContain(`vercel:${id}:nomic-embed-text:v1.5`);

      const disabled = await agent.patch(`/api/providers/${id}/models/${model.id}`).send({ enabled: false }).expect(200);
      expect(disabled.body.model.enabled).toBe(false);

      fetchMock
        .mockResolvedValueOnce(tagsResponse())
        .mockResolvedValueOnce(showResponse());
      const rediscovered = await agent.post(`/api/providers/${id}/discover`).expect(200);
      expect(rediscovered.body.models[0].enabled).toBe(false);
    });

    it("shows disabled embedding models in Settings as unavailable choices", async () => {
      const dataDir = tmpDataDir();
      const { agent, db } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      }).expect(201);

      const id = createRes.body.provider.id;
      upsertModel({
        db,
        providerId: id,
        modelName: "nomic-embed-text:v1.5",
        displayName: "nomic-embed-text:v1.5",
        capabilities: { advertised_capabilities: ["embedding"], embedding: true, chat: false },
        enabled: false,
      });

      const embeddingModels = await agent.get("/api/models/embeddings").expect(200);
      const option = embeddingModels.body.groups
        .flatMap((group) => group.models)
        .find((modelOption) => modelOption.value === `vercel:${id}:nomic-embed-text:v1.5`);
      expect(option).toMatchObject({
        available: false,
        disabled: true,
        unavailable_reason: "Model is disabled in Providers.",
      });
    });

    it("rejects enabling models that are neither runnable nor embedding-capable", async () => {
      const dataDir = tmpDataDir();
      const { agent, db } = makeTestServer({ dataDir });

      const createRes = await agent.post("/api/providers").send({
        name: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      }).expect(201);

      const id = createRes.body.provider.id;
      const model = upsertModel({
        db,
        providerId: id,
        modelName: "reranker-local",
        displayName: "reranker-local",
        capabilities: { advertised_capabilities: ["rerank"], chat: false, embedding: false },
        enabled: false,
      });

      const res = await agent.patch(`/api/providers/${id}/models/${model.id}`).send({ enabled: true }).expect(400);
      expect(res.body.error.message).toMatch(/not runnable for agents or embeddings/i);
    });
  });
});
