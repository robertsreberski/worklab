import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import {
  chunkMarkdown,
  cosineSimilarity,
  floatArrayToBuffer,
  bufferToFloatArray,
  getIndexStatus,
  indexSource,
  parseEmbeddingReference,
  search,
} from "../../core/embeddings.js";

describe("embedding references", () => {
  it("requires exact provider:model references", () => {
    expect(parseEmbeddingReference("ollama:nomic-embed-text")).toMatchObject({
      kind: "ollama",
      model: "nomic-embed-text",
    });
    expect(parseEmbeddingReference("openai:text-embedding-3-small")).toMatchObject({
      kind: "openai",
      model: "text-embedding-3-small",
    });
    expect(parseEmbeddingReference("vercel:local:text-embedding-3-small")).toMatchObject({
      kind: "vercel",
      providerId: "local",
      model: "text-embedding-3-small",
    });
    expect(parseEmbeddingReference("provider:local:text-embedding-3-small")).toMatchObject({
      kind: "vercel",
      providerId: "local",
      model: "text-embedding-3-small",
      reference: "vercel:local:text-embedding-3-small",
    });

    expect(() => parseEmbeddingReference("sonnet")).toThrow(/invalid embedding model reference/);
    expect(() => parseEmbeddingReference("openai:sonnet")).toThrow(/tier aliases/);
    expect(() => parseEmbeddingReference("vercel:local:haiku")).toThrow(/tier aliases/);
  });
});

describe("embedding index", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function fixture() {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-embeddings-"));
    dirs.push(dataDir);
    const db = openDb(":memory:");
    runMigrations(db);
    return { db, dataDir };
  }

  it("chunks markdown by headings and oversized sections", () => {
    const chunks = chunkMarkdown("# Alpha\none\n# Beta\ntwo", 100);
    expect(chunks).toEqual(["# Alpha\none", "# Beta\ntwo"]);
    expect(chunkMarkdown("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("round-trips vectors and scores cosine similarity", () => {
    const original = new Float32Array([1, 0, 0]);
    const copy = bufferToFloatArray(floatArrayToBuffer(original));
    expect([...copy]).toEqual([1, 0, 0]);
    expect(cosineSimilarity(original, new Float32Array([1, 0, 0]))).toBe(1);
    expect(cosineSimilarity(original, new Float32Array([0, 1, 0]))).toBe(0);
  });

  it("indexes FTS rows even when vector generation is disabled", async () => {
    const { db, dataDir } = fixture();
    await indexSource({
      db,
      dataDir,
      allowVector: false,
      source: {
        kind: "kb",
        source_ref: "knowledge/deploy-runbook.md",
        title: "Deploy Runbook",
        body: "Use blue green deploys for the billing service.",
      },
    });

    const results = await search({
      db,
      dataDir,
      kind: "kb",
      query: "blue green billing",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    expect(results[0]).toMatchObject({
      kind: "kb",
      slug: "deploy-runbook",
      title: "Deploy Runbook",
    });

    const status = getIndexStatus(db);
    expect(status.total).toBe(1);
    expect(status.vectorized).toBe(0);
    expect(status.byKind.kb).toBe(1);
  });

  it("preserves unchanged chunks instead of deleting and reinserting them", async () => {
    const { db, dataDir } = fixture();
    const source = {
      kind: "kb",
      source_ref: "knowledge/stable-runbook.md",
      title: "Stable Runbook",
      body: "Keep this content stable across startup scans.",
    };

    await indexSource({ db, dataDir, allowVector: false, source });
    const first = db.prepare("SELECT id, updated_at FROM embeddings WHERE source_ref = ?").get("knowledge/stable-runbook.md#chunk-0");

    await indexSource({ db, dataDir, allowVector: false, source });
    const second = db.prepare("SELECT id, updated_at FROM embeddings WHERE source_ref = ?").get("knowledge/stable-runbook.md#chunk-0");
    const ftsCount = db.prepare("SELECT COUNT(*) AS count FROM embeddings_fts WHERE source_ref = ?").get("knowledge/stable-runbook.md#chunk-0").count;

    expect(second).toEqual(first);
    expect(ftsCount).toBe(1);
  });

  it("keeps FTS results when vector reranking sees null candidate vectors", async () => {
    const { db, dataDir } = fixture();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("default_embedding_model", JSON.stringify("ollama:nomic-embed-text"));

    await indexSource({
      db,
      dataDir,
      allowVector: false,
      source: {
        kind: "kb",
        source_ref: "knowledge/release-freeze.md",
        title: "Release Freeze",
        body: "During release freeze, only ship incident rollback fixes.",
      },
    });

    const results = await search({
      db,
      dataDir,
      kind: "kb",
      query: "incident rollback",
      fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [[1, 0]] }) }),
    });

    expect(results[0]).toMatchObject({
      kind: "kb",
      slug: "release-freeze",
      title: "Release Freeze",
    });
  });

  it("uses vectors when embeddings are available", async () => {
    const { db, dataDir } = fixture();
    const fetchImpl = async (_url, options) => {
      const { input } = JSON.parse(options.body);
      const vector = /database|postgres/i.test(input) ? [0, 1] : [1, 0];
      return { ok: true, json: async () => ({ embeddings: [vector] }) };
    };

    await indexSource({
      db,
      dataDir,
      modelRef: "ollama:nomic-embed-text",
      fetchImpl,
      source: {
        kind: "memory",
        agent: "alice",
        source_ref: "agents/alice/MEMORY.md",
        title: "Memory: alice",
        body: "Frontend build notes and CSS practices.",
      },
    });
    await indexSource({
      db,
      dataDir,
      modelRef: "ollama:nomic-embed-text",
      fetchImpl,
      source: {
        kind: "memory",
        agent: "bob",
        source_ref: "agents/bob/MEMORY.md",
        title: "Memory: bob",
        body: "Postgres database migrations and backup windows.",
      },
    });

    const rows = db
      .prepare("SELECT vector_present FROM embeddings ORDER BY source_ref")
      .all()
      .map((row) => row.vector_present);
    expect(rows).toEqual([1, 1]);

    const results = await search({
      db,
      dataDir,
      kind: "memory",
      query: "database",
      fetchImpl,
    });
    expect(results[0]).toMatchObject({ agent: "bob", title: "Memory: bob" });
    expect(getIndexStatus(db).vectorized).toBe(2);
  });
});
