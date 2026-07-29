import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { newEmbeddingId } from "./ids.js";
import { kbList, kbRead } from "./kb.js";
import { agentJournalPath, agentMemoryPath } from "./journal.js";
import { getProvider, isPrivateBaseUrl } from "./providers.js";
import { getSettingValue } from "./db/queries/settings.js";

const MAX_CHUNK_CHARS = 1800;
const MAX_EMBED_CHARS = 8000;
const MAX_CONSECUTIVE_VECTOR_FAILURES = 3;
const TIER_ALIASES = new Set(["haiku", "sonnet", "opus"]);
export const DEFAULT_EMBEDDING_MODEL = "";

function cleanPart(value, message) {
  if (!value || typeof value !== "string" || value.trim() !== value) throw new Error(message);
  return value;
}

export function parseEmbeddingReference(value) {
  if (!value || typeof value !== "string") throw new Error("embedding model reference required");
  const i = value.indexOf(":");
  if (i <= 0 || i === value.length - 1) {
    throw new Error("invalid embedding model reference; expected ollama:<model>, openai:<model>, or vercel:<providerId>:<model>");
  }
  const kind = value.slice(0, i);
  const rest = value.slice(i + 1);
  if (kind === "ollama" || kind === "openai") {
    const model = cleanPart(rest, "embedding model id required");
    if (TIER_ALIASES.has(model)) throw new Error("tier aliases are not valid embedding model references; use an exact model id");
    return { kind, model, reference: value };
  }
  if (kind === "vercel" || kind === "provider") {
    const j = rest.indexOf(":");
    if (j <= 0 || j === rest.length - 1) throw new Error("invalid custom embedding reference; expected vercel:<providerId>:<model>");
    const providerId = cleanPart(rest.slice(0, j), "provider id required");
    const model = cleanPart(rest.slice(j + 1), "embedding model id required");
    if (TIER_ALIASES.has(model)) throw new Error("tier aliases are not valid embedding model references; use an exact model id");
    return { kind: "vercel", providerId, model, reference: `vercel:${providerId}:${model}`, rawReference: value };
  }
  throw new Error(`unknown embedding provider: ${kind}`);
}

export function hashText(text) {
  return createHash("sha256").update(text || "").digest("hex");
}

export function floatArrayToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloatArray(buf) {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function rootUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
}

function v1Url(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function parseNonNegativeInt(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function resolveEmbeddingTimeoutMs({ parsed, provider, purpose = "index" }) {
  const query = purpose === "query";
  const local = parsed.kind === "ollama" || (provider && isPrivateBaseUrl(provider.base_url));
  const name = query ? "WORKLAB_EMBEDDING_QUERY_TIMEOUT_MS" : "WORKLAB_EMBEDDING_TIMEOUT_MS";
  const fallback = query ? 10_000 : (local ? 60_000 : 15_000);
  return parseNonNegativeInt(process.env[name], fallback, name);
}

async function postJson(url, body, { headers = {}, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error(`${url} returned ${resp.status}`);
  return await resp.json();
}

function firstEmbedding(data) {
  const vector = data?.embedding
    || data?.embeddings?.[0]
    || data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("embedding response did not include a vector");
  return new Float32Array(vector.map(Number));
}

function isRetryableTransportError(err) {
  return err?.name === "AbortError"
    || err?.name === "TimeoutError"
    || err?.code === "ECONNRESET"
    || /fetch failed/i.test(err?.message || "");
}

function isTimeoutError(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || /timed out|timeout/i.test(err?.message || "");
}

export async function generateEmbedding({
  db,
  dataDir,
  modelRef,
  text,
  fetchImpl = fetch,
  purpose = "index",
  timeoutMs,
}) {
  const parsed = parseEmbeddingReference(modelRef);
  const input = String(text || "").slice(0, MAX_EMBED_CHARS);
  if (!input.trim()) return { vector: null, error: "empty input" };

  let provider = null;
  let label;
  let url;
  let headers = {};
  try {
    if (parsed.kind === "ollama") {
      label = "Ollama";
      url = `${process.env.WORKLAB_OLLAMA_BASE_URL || "http://localhost:11434"}/api/embed`;
    } else if (parsed.kind === "openai") {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
      label = "OpenAI";
      url = "https://api.openai.com/v1/embeddings";
      headers = authHeaders(process.env.OPENAI_API_KEY);
    } else {
      provider = getProvider({ db, dataDir, id: parsed.providerId, includeKey: true });
      if (!provider) throw new Error(`provider not found: ${parsed.providerId}`);
      if (!provider.enabled) throw new Error(`provider disabled: ${parsed.providerId}`);
      label = provider.name || parsed.providerId;
      url = provider.provider_type === "ollama"
        ? `${rootUrl(provider.base_url)}/api/embed`
        : `${v1Url(provider.base_url)}/embeddings`;
      headers = authHeaders(provider.api_key);
    }

    const budget = timeoutMs ?? resolveEmbeddingTimeoutMs({ parsed, provider, purpose });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await postJson(url, { model: parsed.model, input }, { fetchImpl, headers, timeoutMs: budget });
        return { vector: firstEmbedding(data), error: null };
      } catch (err) {
        if (attempt === 0 && isRetryableTransportError(err)) continue;
        if (isTimeoutError(err)) {
          throw new Error(`${label} (${url}) did not respond within ${budget}ms — the model may still be loading`);
        }
        throw err;
      }
    }
  } catch (err) {
    return { vector: null, error: err.message || String(err) };
  }
}

export function isEmbeddingBackendReady({ db, dataDir, modelRef }) {
  if (!modelRef) return { ready: false, reason: "no embedding model configured" };
  let parsed;
  try { parsed = parseEmbeddingReference(modelRef); }
  catch (err) { return { ready: false, reason: err.message || "invalid embedding reference" }; }

  if (parsed.kind === "ollama") return { ready: true, reason: null };
  if (parsed.kind === "openai") {
    if (!process.env.OPENAI_API_KEY) return { ready: false, reason: "OPENAI_API_KEY is not set" };
    return { ready: true, reason: null };
  }
  const provider = getProvider({ db, dataDir, id: parsed.providerId });
  if (!provider) return { ready: false, reason: `provider ${parsed.providerId} was removed` };
  if (!provider.enabled) return { ready: false, reason: `provider ${provider.name} is disabled` };
  if (!provider.has_api_key && !isPrivateBaseUrl(provider.base_url)) {
    return { ready: false, reason: `provider ${provider.name} needs an API key` };
  }
  return { ready: true, reason: null };
}

export function getEmbeddingModel(db) {
  const raw = getSettingValue(db, "default_embedding_model");
  if (raw == null) return DEFAULT_EMBEDDING_MODEL;
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  return value || "";
}

export function chunkMarkdown(text, maxChars = MAX_CHUNK_CHARS) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const sections = [];
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    if (/^#{1,4}\s+/.test(line) && current.trim()) {
      sections.push(current.trim());
      current = "";
    }
    current += `${line}\n`;
  }
  if (current.trim()) sections.push(current.trim());

  const chunks = [];
  for (const section of sections.length ? sections : [raw]) {
    if (section.length <= maxChars) {
      chunks.push(section);
      continue;
    }
    for (let i = 0; i < section.length; i += maxChars) {
      const part = section.slice(i, i + maxChars).trim();
      if (part) chunks.push(part);
    }
  }
  return chunks;
}

function deleteSourcePrefix(db, kind, sourceRef) {
  const rows = db.prepare("SELECT id FROM embeddings WHERE kind = ? AND source_ref LIKE ?").all(kind, `${sourceRef}#%`);
  const delFts = db.prepare("DELETE FROM embeddings_fts WHERE id = ?");
  const delEmb = db.prepare("DELETE FROM embeddings WHERE id = ?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      delFts.run(row.id);
      delEmb.run(row.id);
    }
  });
  tx();
}

function deleteStaleSourceChunks(db, kind, sourceRef, keepRefs) {
  const rows = db.prepare("SELECT id, source_ref FROM embeddings WHERE kind = ? AND source_ref LIKE ?").all(kind, `${sourceRef}#%`);
  const delFts = db.prepare("DELETE FROM embeddings_fts WHERE id = ?");
  const delEmb = db.prepare("DELETE FROM embeddings WHERE id = ?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (keepRefs.has(row.source_ref)) continue;
      delFts.run(row.id);
      delEmb.run(row.id);
    }
  });
  tx();
}

export function removeSource({ db, kind, sourceRef }) {
  deleteSourcePrefix(db, kind, sourceRef);
}

function sourceToChunks(source) {
  return chunkMarkdown(source.body).map((chunkText, index) => ({
    ...source,
    source_ref: `${source.source_ref}#chunk-${index}`,
    chunk_text: chunkText,
    content_hash: hashText(chunkText),
  }));
}

function getExistingChunk(db, kind, sourceRef) {
  return db.prepare("SELECT id, content_hash, model, indexing_error FROM embeddings WHERE kind = ? AND source_ref = ?").get(kind, sourceRef);
}

function hasEmbeddingColumn(db, column) {
  return db.prepare("PRAGMA table_info(embeddings)").all().some((row) => row.name === column);
}

function unchangedChunk(existing, chunk, model) {
  return Boolean(
    existing
    && existing.content_hash === chunk.content_hash
    && (existing.model || null) === (model || null)
    && !existing.indexing_error
  );
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function upsertChunk(db, chunk, { vector, model, error }) {
  const now = Date.now();
  const existing = getExistingChunk(db, chunk.kind, chunk.source_ref);
  if (unchangedChunk(existing, chunk, model) && !error) return existing.id;
  const id = existing?.id || newEmbeddingId();
  const vectorBuf = vector ? floatArrayToBuffer(vector) : null;
  const vectorPresent = vectorBuf ? 1 : 0;
  db.prepare(`
    INSERT INTO embeddings
      (id, kind, ref, source_ref, agent, title, chunk_text, vector, vector_present, model, content_hash, indexing_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, source_ref) DO UPDATE SET
      ref = excluded.ref,
      agent = excluded.agent,
      title = excluded.title,
      chunk_text = excluded.chunk_text,
      vector = excluded.vector,
      vector_present = excluded.vector_present,
      model = excluded.model,
      content_hash = excluded.content_hash,
      indexing_error = excluded.indexing_error,
      updated_at = excluded.updated_at
  `).run(
    id,
    chunk.kind,
    chunk.source_ref,
    chunk.source_ref,
    chunk.agent || null,
    chunk.title || null,
    chunk.chunk_text,
    vectorBuf,
    vectorPresent,
    model || null,
    chunk.content_hash,
    error || null,
    now,
    now,
  );
  db.prepare("DELETE FROM embeddings_fts WHERE id = ?").run(id);
  db.prepare("INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text) VALUES (?, ?, ?, ?, ?)")
    .run(id, chunk.kind, chunk.source_ref, chunk.title || "", chunk.chunk_text);
  return id;
}

export async function indexSource({
  db,
  dataDir,
  source,
  modelRef = getEmbeddingModel(db),
  fetchImpl = fetch,
  allowVector = true,
  vectorState = { consecutiveFailures: 0, disabledReason: null },
}) {
  const chunks = sourceToChunks(source);
  const keepRefs = new Set(chunks.map((chunk) => chunk.source_ref));
  const out = [];
  let vectorEnabled = allowVector && vectorState.consecutiveFailures < MAX_CONSECUTIVE_VECTOR_FAILURES;
  for (const chunk of chunks) {
    let vector = null;
    let error = null;
    const targetModel = vectorEnabled && modelRef ? modelRef : null;
    const existing = getExistingChunk(db, chunk.kind, chunk.source_ref);
    if (unchangedChunk(existing, chunk, targetModel)) {
      out.push(existing.id);
      continue;
    }
    if (vectorEnabled) {
      const embedded = await generateEmbedding({
        db,
        dataDir,
        modelRef,
        text: chunk.chunk_text,
        fetchImpl,
        purpose: "index",
      });
      vector = embedded.vector;
      error = embedded.error;
      if (error) {
        vectorState.consecutiveFailures += 1;
        if (vectorState.consecutiveFailures >= MAX_CONSECUTIVE_VECTOR_FAILURES) {
          vectorState.disabledReason = error;
          vectorEnabled = false;
        }
      } else {
        vectorState.consecutiveFailures = 0;
      }
    }
    out.push(upsertChunk(db, chunk, { vector, model: vector ? modelRef : null, error }));
    if (out.length % 25 === 0) await yieldToEventLoop();
  }
  deleteStaleSourceChunks(db, source.kind, source.source_ref, keepRefs);
  return out;
}

export function scanSources({ dataDir, kind = "all" } = {}) {
  const sources = [];
  if (kind === "all" || kind === "kb") {
    for (const meta of kbList({ dataDir })) {
      const entry = kbRead({ dataDir, slug: meta.slug });
      if (!entry) continue;
      sources.push({
        kind: "kb",
        source_ref: `knowledge/${meta.slug}.md`,
        title: entry.meta.title || meta.slug,
        body: kbIndexBody(entry),
        slug: meta.slug,
      });
    }
  }

  const agentsDir = join(dataDir, "agents");
  if (existsSync(agentsDir) && (kind === "all" || kind === "journal" || kind === "memory")) {
    for (const agent of readdirSync(agentsDir)) {
      if (agent.startsWith(".")) continue;
      if (kind === "all" || kind === "journal") {
        const path = agentJournalPath(dataDir, agent);
        if (existsSync(path)) {
          sources.push({
            kind: "journal",
            agent,
            source_ref: `agents/${agent}/JOURNAL.md`,
            title: `Journal: ${agent}`,
            body: readFileSync(path, "utf8"),
          });
        }
      }
      if (kind === "all" || kind === "memory") {
        const path = agentMemoryPath(dataDir, agent);
        if (existsSync(path)) {
          sources.push({
            kind: "memory",
            agent,
            source_ref: `agents/${agent}/MEMORY.md`,
            title: `Memory: ${agent}`,
            body: readFileSync(path, "utf8"),
          });
        }
      }
    }
  }
  return sources.filter((source) => String(source.body || "").trim().length > 0);
}

function kbIndexBody(entry) {
  const meta = entry.meta || {};
  const lines = [
    meta.project_id ? `Project: ${meta.project_id}` : "",
    meta.category ? `Category: ${meta.category}` : "",
    meta.subcategory ? `Subcategory: ${meta.subcategory}` : "",
    Array.isArray(meta.tags) && meta.tags.length ? `Tags: ${meta.tags.join(", ")}` : "",
  ].filter(Boolean);
  if (!lines.length) return entry.body;
  return `${lines.join("\n")}\n\n${entry.body || ""}`;
}

export async function indexAllSources({ db, dataDir, fetchImpl = fetch, shouldStop = () => false } = {}) {
  const modelRef = getEmbeddingModel(db);
  const sources = scanSources({ dataDir });
  const readiness = isEmbeddingBackendReady({ db, dataDir, modelRef });
  const stats = { sources: 0, chunks: 0, model: modelRef || null, ready: readiness.ready, reason: readiness.reason };
  let allowVector = !!modelRef && readiness.ready;
  const vectorState = { consecutiveFailures: 0, disabledReason: null };
  for (const source of sources) {
    if (shouldStop()) { stats.aborted = true; break; }
    const ids = await indexSource({
      db,
      dataDir,
      source,
      modelRef: modelRef || null,
      fetchImpl,
      allowVector,
      vectorState,
    });
    allowVector = allowVector && vectorState.consecutiveFailures < MAX_CONSECUTIVE_VECTOR_FAILURES;
    if (!allowVector && vectorState.disabledReason) stats.vector_disabled_reason = vectorState.disabledReason;
    stats.sources += 1;
    stats.chunks += ids.length;
    await yieldToEventLoop();
  }
  return stats;
}

export async function indexPath({ db, dataDir, filePath, fetchImpl = fetch }) {
  const modelRef = getEmbeddingModel(db);
  const allowVector = !!modelRef && isEmbeddingBackendReady({ db, dataDir, modelRef }).ready;
  const rel = relative(dataDir, filePath).split(sep).join("/");
  if (/^knowledge\/[^/]+\.md$/.test(rel)) {
    const slug = basename(rel, ".md");
    if (!existsSync(filePath)) return removeSource({ db, kind: "kb", sourceRef: `knowledge/${slug}.md` });
    const entry = kbRead({ dataDir, slug });
    if (!entry) return;
    return indexSource({
      db,
      dataDir,
      fetchImpl,
      modelRef: modelRef || null,
      allowVector,
      source: { kind: "kb", source_ref: `knowledge/${slug}.md`, title: entry.meta.title || slug, body: kbIndexBody(entry), slug },
    });
  }
  const m = /^agents\/([^/]+)\/(JOURNAL|MEMORY)\.md$/.exec(rel);
  if (!m) return null;
  const [, agent, name] = m;
  const kind = name === "JOURNAL" ? "journal" : "memory";
  const sourceRef = `agents/${agent}/${name}.md`;
  if (!existsSync(filePath)) return removeSource({ db, kind, sourceRef });
  return indexSource({
    db,
    dataDir,
    fetchImpl,
    modelRef: modelRef || null,
    allowVector,
    source: { kind, agent, source_ref: sourceRef, title: `${name === "JOURNAL" ? "Journal" : "Memory"}: ${agent}`, body: readFileSync(filePath, "utf8") },
  });
}

function searchTokens(query) {
  return String(query || "").toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function snippet(text, tokens) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return "";
  const lower = body.toLowerCase();
  const idx = tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, idx - 80);
  return `${start > 0 ? "..." : ""}${body.slice(start, start + 220)}${start + 220 < body.length ? "..." : ""}`;
}

function resultFromRow(row, score, tokens) {
  const source = row.source_ref.split("#chunk-")[0];
  const slugMatch = /^knowledge\/(.+)\.md$/.exec(source);
  const agentMatch = /^agents\/([^/]+)\//.exec(source);
  return {
    kind: row.kind,
    ref: row.source_ref,
    source_ref: source,
    title: row.title || source,
    agent: row.agent || agentMatch?.[1] || null,
    slug: slugMatch?.[1] || null,
    snippet: snippet(row.chunk_text, tokens),
    score,
  };
}

function kbFiltersActive(filters) {
  return ["tag", "category", "subcategory", "project_id"].some((key) => filters[key] !== undefined && filters[key] !== null && filters[key] !== "");
}

function kbResultMatches({ dataDir, result, filters }) {
  if (result.kind !== "kb" || !kbFiltersActive(filters)) return true;
  if (!result.slug) return false;
  const entry = kbRead({ dataDir, slug: result.slug });
  if (!entry) return false;
  const meta = entry.meta || {};
  if (filters.project_id !== undefined && meta.project_id !== filters.project_id) return false;
  if (filters.category !== undefined && meta.category !== filters.category) return false;
  if (filters.subcategory !== undefined && meta.subcategory !== filters.subcategory) return false;
  if (filters.tag !== undefined && !(Array.isArray(meta.tags) && meta.tags.includes(filters.tag))) return false;
  return true;
}

export async function search({
  db,
  dataDir,
  query,
  kind = "all",
  agent = null,
  limit = 8,
  tag,
  category,
  subcategory,
  project_id,
  fetchImpl = fetch,
} = {}) {
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const capped = Math.max(1, Math.min(Number(limit) || 8, 50));
  const kbFilters = { tag, category, subcategory, project_id };
  const where = [];
  const params = [];
  if (kind && kind !== "all") {
    where.push("e.kind = ?");
    params.push(kind);
  }
  if (agent) {
    where.push("e.agent = ?");
    params.push(agent);
  }
  const filter = where.length ? ` AND ${where.join(" AND ")}` : "";
  const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
  let ftsRows = [];
  try {
    ftsRows = db.prepare(`
      SELECT e.*, bm25(embeddings_fts) AS rank
      FROM embeddings_fts
      JOIN embeddings e ON e.id = embeddings_fts.id
      WHERE embeddings_fts MATCH ?${filter}
      LIMIT ?
    `).all(match, ...params, capped * 4);
  } catch {
    ftsRows = [];
  }

  const scores = new Map();
  ftsRows.forEach((row, index) => {
    scores.set(row.id, { row, fts: 1 - (index / Math.max(1, ftsRows.length)) });
  });

  const modelRef = getEmbeddingModel(db);
  // Only do vector search if we have an embedding model configured AND
  // FTS returned some candidate IDs to narrow the scope.  This avoids the
  // O(n) full-table-vector scan on large datasets by only computing cosine
  // similarity for FTS-candidate chunks rather than every chunk in the DB.
  const ftsIds = [...scores.keys()];
  if (modelRef && ftsIds.length) {
    const queryEmbedding = await generateEmbedding({
      db,
      dataDir,
      modelRef,
      text: query,
      fetchImpl,
      purpose: "query",
    });
    if (queryEmbedding.vector) {
      const idList = ftsIds.map(() => "?").join(",");
      const vecRows = db.prepare(`
        SELECT id, vector FROM embeddings
        WHERE id IN (${idList}) AND vector IS NOT NULL
      `).all(...ftsIds);
      for (const row of vecRows) {
        if (!row.vector) continue;
        const sim = cosineSimilarity(queryEmbedding.vector, bufferToFloatArray(row.vector));
        if (sim <= 0) continue;
        const existing = scores.get(row.id) || { row: db.prepare(`
          SELECT * FROM embeddings WHERE id = ?
        `).get(row.id), fts: 0 };
        existing.vector = sim;
        scores.set(row.id, existing);
      }
    }
  }

  const ranked = [...scores.values()]
    .map((item) => {
      const hasFts = item.fts != null && item.fts > 0;
      const hasVector = item.vector != null && item.vector > 0;
      const score = hasFts && hasVector
        ? (item.vector * 0.65) + (item.fts * 0.35)
        : (item.vector || item.fts || 0);
      return resultFromRow(item.row, score, tokens);
    })
    .sort((a, b) => b.score - a.score)
    .filter((result) => kbResultMatches({ dataDir, result, filters: kbFilters }))
    .slice(0, capped);
  return ranked;
}

export function getIndexStatus(db, { dataDir } = {}) {
  const total = db.prepare("SELECT COUNT(*) AS count FROM embeddings").get().count;
  const byKind = db.prepare("SELECT kind, COUNT(*) AS count FROM embeddings GROUP BY kind").all()
    .reduce((acc, row) => ({ ...acc, [row.kind]: row.count }), {});
  const vectorizedWhere = hasEmbeddingColumn(db, "vector_present")
    ? "vector_present = 1"
    : "vector IS NOT NULL";
  const vectorized = db.prepare(`SELECT COUNT(*) AS count FROM embeddings WHERE ${vectorizedWhere}`).get().count;
  const errors = db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE indexing_error IS NOT NULL").get().count;
  const model = getEmbeddingModel(db);
  const readiness = model ? isEmbeddingBackendReady({ db, dataDir, modelRef: model }) : { ready: false, reason: null };
  return { total, byKind, vectorized, errors, model: model || null, ready: readiness.ready, reason: readiness.reason };
}

export async function testEmbeddingBackend({ db, dataDir, fetchImpl = fetch } = {}) {
  const modelRef = getEmbeddingModel(db);
  if (!modelRef) return { ok: false, model: null, kind: null, error: "embedding model not configured", dimensions: 0 };
  const parsed = parseEmbeddingReference(modelRef);
  const result = await generateEmbedding({
    db,
    dataDir,
    modelRef,
    text: "worklab embedding health check",
    fetchImpl,
    purpose: "test",
  });
  return {
    ok: !!result.vector,
    model: modelRef,
    kind: parsed.kind,
    error: result.error || null,
    dimensions: result.vector?.length || 0,
  };
}
