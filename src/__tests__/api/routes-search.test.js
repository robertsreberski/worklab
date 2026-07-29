import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { indexPath, indexSource } from "../../core/embeddings.js";
import { kbCreate, kbPath } from "../../core/kb.js";

describe("search routes", () => {
  const dirs = [];
  const oldOllamaBase = process.env.WORKLAB_OLLAMA_BASE_URL;

  afterEach(() => {
    if (oldOllamaBase === undefined) delete process.env.WORKLAB_OLLAMA_BASE_URL;
    else process.env.WORKLAB_OLLAMA_BASE_URL = oldOllamaBase;
    vi.unstubAllGlobals();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function server() {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-search-route-"));
    dirs.push(dataDir);
    return makeTestServer({ dataDir });
  }

  it("returns index status", async () => {
    const { agent } = server();
    const res = await agent.get("/api/search/status").expect(200);
    expect(res.body.status).toMatchObject({
      total: 0,
      vectorized: 0,
      errors: 0,
      model: null,
    });
  });

  it("returns provider-qualified status and tests the configured embedding backend", async () => {
    const { agent, db } = server();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("default_embedding_model", JSON.stringify("ollama:nomic-embed-text"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 0, 0]] }),
    }));

    const status = await agent.get("/api/search/status").expect(200);
    expect(status.body.status).toMatchObject({
      model: "ollama:nomic-embed-text",
      model_label: "Ollama / nomic-embed-text",
      provider_name: "Ollama",
      model_name: "nomic-embed-text",
    });

    const result = await agent.get("/api/search/embedding-test").expect(200);
    expect(result.body.test).toMatchObject({
      ok: true,
      model: "ollama:nomic-embed-text",
      label: "Ollama / nomic-embed-text",
      kind: "ollama",
      dimensions: 3,
      error: null,
    });
    expect(result.body.test.duration_ms).toEqual(expect.any(Number));
  });

  it("surfaces embedding backend test failures", async () => {
    const { agent, db } = server();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("default_embedding_model", JSON.stringify("ollama:missing"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await agent.get("/api/search/embedding-test").expect(200);
    expect(result.body.test).toMatchObject({
      ok: false,
      model: "ollama:missing",
      label: "Ollama / missing",
      dimensions: 0,
    });
    expect(result.body.test.error).toContain("returned 404");
  });

  it("searches indexed knowledge with offline FTS fallback", async () => {
    process.env.WORKLAB_OLLAMA_BASE_URL = "http://127.0.0.1:9";
    const { agent, db } = server();
    await indexSource({
      db,
      dataDir: dirs[dirs.length - 1],
      allowVector: false,
      source: {
        kind: "kb",
        source_ref: "knowledge/incidents.md",
        title: "Incident Notes",
        body: "PagerDuty escalation and rollback checklist.",
      },
    });

    const res = await agent.get("/api/search")
      .query({ q: "rollback pagerduty", kind: "kb" })
      .expect(200);
    expect(res.body.results[0]).toMatchObject({
      kind: "kb",
      slug: "incidents",
      title: "Incident Notes",
    });
  });

  it("indexes knowledge metadata for search", async () => {
    process.env.WORKLAB_OLLAMA_BASE_URL = "http://127.0.0.1:9";
    const { agent, db } = server();
    const dataDir = dirs[dirs.length - 1];
    kbCreate({
      dataDir,
      slug: "metadata-note",
      title: "Metadata Note",
      body: "Plain body.",
      project_id: "project-1",
      category: "research",
      subcategory: "runtime",
      tags: ["observability"],
      author: "human",
    });
    await indexPath({ db, dataDir, filePath: kbPath(dataDir, "metadata-note") });

    const res = await agent.get("/api/search")
      .query({ q: "runtime observability project-1", kind: "kb" })
      .expect(200);
    expect(res.body.results[0]).toMatchObject({
      kind: "kb",
      slug: "metadata-note",
      title: "Metadata Note",
    });
  });

  it("filters knowledge search by project, category, subcategory, and tag", async () => {
    process.env.WORKLAB_OLLAMA_BASE_URL = "http://127.0.0.1:9";
    const { agent, db } = server();
    const dataDir = dirs[dirs.length - 1];
    kbCreate({
      dataDir,
      slug: "target-note",
      title: "Target Note",
      body: "Shared checklist body.",
      project_id: "project-1",
      category: "research",
      subcategory: "runtime",
      tags: ["observability"],
      author: "human",
    });
    kbCreate({
      dataDir,
      slug: "other-note",
      title: "Other Note",
      body: "Shared checklist body.",
      project_id: "project-2",
      category: "research",
      subcategory: "runtime",
      tags: ["observability"],
      author: "human",
    });
    await indexPath({ db, dataDir, filePath: kbPath(dataDir, "target-note") });
    await indexPath({ db, dataDir, filePath: kbPath(dataDir, "other-note") });

    const res = await agent.get("/api/search")
      .query({
        q: "shared checklist",
        kind: "kb",
        project_id: "project-1",
        category: "research",
        subcategory: "runtime",
        tag: "observability",
      })
      .expect(200);
    expect(res.body.results.map((result) => result.slug)).toEqual(["target-note"]);
  });

  it("validates query and kind", async () => {
    const { agent } = server();
    await agent.get("/api/search").expect(400);
    await agent.get("/api/search").query({ q: "x", kind: "tasks" }).expect(400);
  });
});
