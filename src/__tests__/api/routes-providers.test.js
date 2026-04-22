import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { upsertModel } from "../../core/providers.js";

const dirs = [];
function tmpDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "worklab-api-providers-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  });
});
