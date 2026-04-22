import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations } from "../../core/db.js";
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
    expect(parseEmbeddingReference("provider:local:text-embedding-3-small")).toMatchObject({
      kind: "provider",
      providerId: "local",
      model: "text-embedding-3-small",
    });

    expect(() => parseEmbeddingReference("sonnet")).toThrow(/invalid embedding model reference/);
    expect(() => parseEmbeddingReference("openai:sonnet")).toThrow(/tier aliases/);
    expect(() => parseEmbeddingReference("provider:local:haiku")).toThrow(/tier aliases/);
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
