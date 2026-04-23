import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { indexSource } from "../../core/embeddings.js";

describe("search routes", () => {
  const dirs = [];
  const oldOllamaBase = process.env.WORKLAB_OLLAMA_BASE_URL;

  afterEach(() => {
    if (oldOllamaBase === undefined) delete process.env.WORKLAB_OLLAMA_BASE_URL;
    else process.env.WORKLAB_OLLAMA_BASE_URL = oldOllamaBase;
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

  it("validates query and kind", async () => {
    const { agent } = server();
    await agent.get("/api/search").expect(400);
    await agent.get("/api/search").query({ q: "x", kind: "tasks" }).expect(400);
  });
});
