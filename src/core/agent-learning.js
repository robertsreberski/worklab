import { createHash } from "node:crypto";
import { newAgentMemoryId } from "./ids.js";

export const AGENT_MEMORY_KINDS = ["fact", "preference", "procedure", "failure", "decision", "episode"];
export const AGENT_MEMORY_SCOPES = ["agent", "project", "task", "global"];
export const AGENT_MEMORY_STATUSES = ["draft", "approved", "archived"];
const MAX_AGENT_MEMORY_CANDIDATES_PER_BATCH = 8;
const AGENT_LEARNING_CONTEXT_MAX_CHARS = 4000;
const AGENT_LEARNING_CONTEXT_LINE_MAX_CHARS = 600;

const KIND_ORDER = new Map([
  ["procedure", 0],
  ["failure", 1],
  ["preference", 2],
  ["fact", 3],
  ["decision", 4],
  ["episode", 5],
]);

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function oneLine(value, max = 2000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trim() : text;
}

function memoryContentKey(content) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeKind(kind) {
  const text = String(kind || "").trim().toLowerCase();
  return AGENT_MEMORY_KINDS.includes(text) ? text : "fact";
}

function normalizeScope(scope, { projectId = null, taskId = null } = {}) {
  const text = String(scope || "").trim().toLowerCase();
  if (AGENT_MEMORY_SCOPES.includes(text)) return text;
  if (taskId) return "task";
  if (projectId) return "project";
  return "agent";
}

function normalizeStatus(status, confidence, autoApproveThreshold) {
  const text = String(status || "").trim().toLowerCase();
  if (AGENT_MEMORY_STATUSES.includes(text)) return text;
  return confidence >= autoApproveThreshold ? "approved" : "draft";
}

function parseMetadata(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeAgentMemoryCandidate(candidate = {}, defaults = {}) {
  const content = oneLine(candidate.content ?? candidate.memory ?? candidate.text);
  if (!content) return null;
  const confidence = clampConfidence(candidate.confidence);
  const autoApproveThreshold = clampConfidence(defaults.autoApproveThreshold ?? 0.85);
  const scope = normalizeScope(candidate.scope, defaults);
  const normalized = {
    id: candidate.id || newAgentMemoryId(),
    agent_name: defaults.agentName || candidate.agent_name || candidate.agent || null,
    kind: normalizeKind(candidate.kind || candidate.type),
    scope,
    status: normalizeStatus(candidate.status, confidence, autoApproveThreshold),
    content,
    content_key: memoryContentKey(content),
    evidence: oneLine(candidate.evidence, 1200) || null,
    confidence,
    project_id: candidate.project_id ?? candidate.projectId ?? defaults.projectId ?? null,
    task_id: candidate.task_id ?? candidate.taskId ?? defaults.taskId ?? null,
    run_id: candidate.run_id ?? candidate.runId ?? defaults.runId ?? null,
    source: oneLine(candidate.source || defaults.source || "run_result", 80) || "run_result",
    metadata_json: JSON.stringify(parseMetadata(candidate.metadata_json ?? candidate.metadata)),
    supersedes_id: candidate.supersedes_id ?? candidate.supersedesId ?? null,
  };
  if (!normalized.agent_name) return null;
  if (scope !== "project") normalized.project_id = normalized.project_id || null;
  if (scope !== "task") normalized.task_id = normalized.task_id || null;
  return normalized;
}

function rowToMemory(row) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence ?? 0),
    use_count: Number(row.use_count ?? 0),
    metadata: parseMetadata(row.metadata_json),
  };
}

function existingActiveMemory(db, memory) {
  return db.prepare(`
    SELECT * FROM agent_memories
    WHERE agent_name = ?
      AND kind = ?
      AND scope = ?
      AND content_key = ?
      AND status <> 'archived'
    LIMIT 1
  `).get(memory.agent_name, memory.kind, memory.scope, memory.content_key);
}

function strongerStatus(existingStatus, nextStatus) {
  if (nextStatus === "archived") return existingStatus;
  if (existingStatus === "approved" || nextStatus === "approved") return "approved";
  return nextStatus || existingStatus || "draft";
}

export function upsertAgentMemory(db, candidate, options = {}) {
  const now = options.now || Date.now();
  const memory = normalizeAgentMemoryCandidate(candidate, options);
  if (!memory) return { action: "skipped", memory: null };
  const existing = existingActiveMemory(db, memory);
  if (existing) {
    const status = strongerStatus(existing.status, memory.status);
    const confidence = Math.max(Number(existing.confidence || 0), memory.confidence);
    db.prepare(`
      UPDATE agent_memories
      SET status = ?,
          evidence = COALESCE(?, evidence),
          confidence = ?,
          project_id = COALESCE(project_id, ?),
          task_id = COALESCE(task_id, ?),
          run_id = COALESCE(?, run_id),
          source = COALESCE(NULLIF(?, ''), source),
          metadata_json = ?,
          supersedes_id = COALESCE(?, supersedes_id),
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      memory.evidence,
      confidence,
      memory.project_id,
      memory.task_id,
      memory.run_id,
      memory.source,
      memory.metadata_json,
      memory.supersedes_id,
      now,
      existing.id,
    );
    return {
      action: "updated",
      memory: rowToMemory(db.prepare("SELECT * FROM agent_memories WHERE id = ?").get(existing.id)),
    };
  }

  db.prepare(`
    INSERT INTO agent_memories
      (id, agent_name, kind, scope, status, content, content_key, evidence, confidence,
       project_id, task_id, run_id, source, metadata_json, supersedes_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.agent_name,
    memory.kind,
    memory.scope,
    memory.status,
    memory.content,
    memory.content_key,
    memory.evidence,
    memory.confidence,
    memory.project_id,
    memory.task_id,
    memory.run_id,
    memory.source,
    memory.metadata_json,
    memory.supersedes_id,
    now,
    now,
  );
  return {
    action: "inserted",
    memory: rowToMemory(db.prepare("SELECT * FROM agent_memories WHERE id = ?").get(memory.id)),
  };
}

export function recordAgentMemoryCandidates(db, {
  candidates = [],
  agentName,
  projectId = null,
  taskId = null,
  runId = null,
  source = "run_result",
  autoApproveThreshold = 0.85,
  now = Date.now(),
} = {}) {
  const stats = { inserted: 0, updated: 0, skipped: 0, memories: [] };
  const items = Array.isArray(candidates) ? candidates : [];
  const overflow = Math.max(0, items.length - MAX_AGENT_MEMORY_CANDIDATES_PER_BATCH);
  stats.skipped += overflow;
  const tx = db.transaction((items) => {
    for (const candidate of items || []) {
      const result = upsertAgentMemory(db, candidate, {
        agentName,
        projectId,
        taskId,
        runId,
        source,
        autoApproveThreshold,
        now,
      });
      stats[result.action] += 1;
      if (result.memory) stats.memories.push(result.memory);
    }
  });
  tx(items.slice(0, MAX_AGENT_MEMORY_CANDIDATES_PER_BATCH));
  return stats;
}

function agentLearningNativeEnabled(settings = {}) {
  return settings.agent_learning_enabled !== false;
}

function failureCandidateFromRun(run) {
  const processStatus = run?.process_status || run?.processStatus || run?.status;
  if (processStatus !== "failed" && processStatus !== "abandoned") return null;
  const detail = oneLine(run.error_text || run.details || run.summary || run.failure_kind);
  if (!detail) return null;
  return {
    kind: "failure",
    scope: "agent",
    status: "draft",
    content: `Prior run ${run.id || ""} failed${run.failure_kind ? ` with ${run.failure_kind}` : ""}: ${detail}`,
    evidence: run.id ? `Task run ${run.id}` : "",
    confidence: 0.55,
    source: "run_failure",
  };
}

export function recordRunResultLearning(db, {
  task = null,
  run = null,
  result = null,
  settings = {},
  now = Date.now(),
} = {}) {
  const empty = { inserted: 0, updated: 0, skipped: 0, memories: [] };
  if (!agentLearningNativeEnabled(settings)) return { ...empty, disabled: true };
  const explicit = Array.isArray(result?.memory_candidates) ? result.memory_candidates : [];
  const failure = explicit.length ? null : failureCandidateFromRun(run);
  const candidates = failure ? [failure] : explicit;
  if (!candidates.length) return empty;
  return recordAgentMemoryCandidates(db, {
    agentName: run?.agent_name || run?.agentName,
    projectId: task?.project_id || task?.projectId || run?.project_id || run?.projectId || null,
    taskId: task?.id || run?.task_id || run?.taskId || null,
    runId: run?.id || null,
    source: failure ? "run_failure" : "run_result",
    autoApproveThreshold: settings.agent_learning_auto_approve_threshold ?? 0.85,
    now,
    candidates,
  });
}

export function listAgentMemories(db, { agentName, status = null, kind = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (agentName) {
    where.push("agent_name = ?");
    params.push(agentName);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    SELECT * FROM agent_memories
    ${filter}
    ORDER BY
      CASE status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      CASE kind WHEN 'procedure' THEN 0 WHEN 'failure' THEN 1 WHEN 'preference' THEN 2 WHEN 'fact' THEN 3 WHEN 'decision' THEN 4 ELSE 5 END,
      updated_at DESC,
      rowid DESC
    LIMIT ?
  `).all(...params, capped).map(rowToMemory);
}

export function summarizeAgentMemories(db, { agentName, kind = null } = {}) {
  const where = [];
  const params = [];
  if (agentName) {
    where.push("agent_name = ?");
    params.push(agentName);
  }
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM agent_memories
    ${filter}
    GROUP BY status
  `).all(...params);
  const summary = { total: 0, active: 0, draft: 0, approved: 0, archived: 0 };
  for (const row of rows) {
    const count = Number(row.count || 0);
    summary.total += count;
    if (row.status === "draft") summary.draft += count;
    else if (row.status === "approved") summary.approved += count;
    else if (row.status === "archived") summary.archived += count;
    if (row.status !== "archived") summary.active += count;
  }
  return summary;
}

function queryTokens(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function memorySnippet(memory, tokens) {
  const body = [memory.content, memory.evidence].filter(Boolean).join(" ");
  const lower = body.toLowerCase();
  const first = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 60);
  const end = Math.min(body.length, start + 220);
  return `${start > 0 ? "..." : ""}${body.slice(start, end)}${end < body.length ? "..." : ""}`;
}

export function searchAgentMemories(db, { query, agentName = null, status = "approved", limit = 8 } = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const capped = Math.max(1, Math.min(Number(limit) || 8, 50));
  const where = ["status = ?"];
  const params = [status];
  if (agentName) {
    where.push("agent_name = ?");
    params.push(agentName);
  }
  const rows = db.prepare(`
    SELECT * FROM agent_memories
    WHERE ${where.join(" AND ")}
    ORDER BY updated_at DESC
    LIMIT 500
  `).all(...params).map(rowToMemory);
  return rows
    .map((memory) => {
      const haystack = `${memory.content} ${memory.evidence || ""}`.toLowerCase();
      const matches = tokens.filter((token) => haystack.includes(token));
      if (!matches.length) return null;
      const tokenScore = matches.length / tokens.length;
      const score = (tokenScore * 0.7) + (Number(memory.confidence || 0) * 0.3);
      return {
        kind: "agent_memory",
        ref: `agent_memories/${memory.id}`,
        source_ref: `agent_memories/${memory.id}`,
        title: `${memory.kind} memory`,
        agent: memory.agent_name,
        memory_kind: memory.kind,
        status: memory.status,
        snippet: memorySnippet(memory, tokens),
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, capped);
}

export function updateAgentMemory(db, id, patch = {}, { now = Date.now() } = {}) {
  const existing = db.prepare("SELECT * FROM agent_memories WHERE id = ?").get(id);
  if (!existing) return null;
  const fields = [];
  const values = [];
  if ("kind" in patch) {
    fields.push("kind = ?");
    values.push(normalizeKind(patch.kind));
  }
  if ("scope" in patch) {
    fields.push("scope = ?");
    values.push(normalizeScope(patch.scope, existing));
  }
  if ("status" in patch) {
    const status = String(patch.status || "").trim().toLowerCase();
    if (!AGENT_MEMORY_STATUSES.includes(status)) throw new Error(`invalid memory status: ${patch.status}`);
    fields.push("status = ?");
    values.push(status);
  }
  if ("content" in patch) {
    const content = oneLine(patch.content);
    if (!content) throw new Error("content is required");
    fields.push("content = ?", "content_key = ?");
    values.push(content, memoryContentKey(content));
  }
  if ("evidence" in patch) {
    fields.push("evidence = ?");
    values.push(oneLine(patch.evidence, 1200) || null);
  }
  if ("confidence" in patch) {
    fields.push("confidence = ?");
    values.push(clampConfidence(patch.confidence));
  }
  if ("project_id" in patch || "projectId" in patch) {
    fields.push("project_id = ?");
    values.push(patch.project_id ?? patch.projectId ?? null);
  }
  if ("task_id" in patch || "taskId" in patch) {
    fields.push("task_id = ?");
    values.push(patch.task_id ?? patch.taskId ?? null);
  }
  if ("metadata" in patch || "metadata_json" in patch) {
    fields.push("metadata_json = ?");
    values.push(JSON.stringify(parseMetadata(patch.metadata_json ?? patch.metadata)));
  }
  if (!fields.length) return rowToMemory(existing);
  fields.push("updated_at = ?");
  values.push(now, id);
  db.prepare(`UPDATE agent_memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return rowToMemory(db.prepare("SELECT * FROM agent_memories WHERE id = ?").get(id));
}

export function selectAgentLearningMemories(db, {
  agentName,
  projectId = null,
  taskId = null,
  limit = 6,
} = {}) {
  if (!agentName) return [];
  const capped = Math.max(1, Math.min(Number(limit) || 6, 25));
  const rows = db.prepare(`
    SELECT * FROM agent_memories
    WHERE agent_name = ?
      AND status = 'approved'
      AND (
        scope = 'agent'
        OR scope = 'global'
        OR (scope = 'project' AND project_id IS NOT NULL AND project_id = ?)
        OR (scope = 'task' AND task_id IS NOT NULL AND task_id = ?)
      )
    ORDER BY
      CASE scope WHEN 'task' THEN 0 WHEN 'project' THEN 1 WHEN 'agent' THEN 2 ELSE 3 END,
      confidence DESC,
      CASE kind WHEN 'procedure' THEN 0 WHEN 'failure' THEN 1 WHEN 'preference' THEN 2 WHEN 'fact' THEN 3 WHEN 'decision' THEN 4 ELSE 5 END,
      updated_at DESC
    LIMIT ?
  `).all(agentName, projectId, taskId, capped);
  return rows
    .map(rowToMemory)
    .sort((a, b) => {
      const ak = KIND_ORDER.get(a.kind) ?? 9;
      const bk = KIND_ORDER.get(b.kind) ?? 9;
      return ak - bk || b.confidence - a.confidence || b.updated_at - a.updated_at;
    });
}

const SECTION_BY_KIND = {
  procedure: "Learned procedures",
  failure: "Known failures",
  preference: "Preferences",
  fact: "Learned facts",
  decision: "Decisions",
  episode: "Episodes",
};

function truncateLearningLine(value, maxChars = AGENT_LEARNING_CONTEXT_LINE_MAX_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const max = Math.max(16, Number(maxChars) || AGENT_LEARNING_CONTEXT_LINE_MAX_CHARS);
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function renderLearningSections(sections, omitted) {
  const body = sections
    .filter((section) => section.lines.length)
    .map((section) => `## ${section.title}\n\n${section.lines.join("\n")}`)
    .join("\n\n");
  const note = omitted > 0 ? `\n\n- Additional learning memories omitted: ${omitted}.` : "";
  return `${body}${note}`.trim();
}

export function formatAgentLearningContext(memories = [], options = {}) {
  const approved = (memories || []).filter((memory) => memory?.status === "approved" && memory.content);
  if (!approved.length) return "";
  const byKind = new Map();
  for (const memory of approved) {
    if (!byKind.has(memory.kind)) byKind.set(memory.kind, []);
    byKind.get(memory.kind).push(memory);
  }
  const sections = AGENT_MEMORY_KINDS
    .filter((kind) => byKind.has(kind))
    .map((kind) => {
      const rows = byKind.get(kind);
      return {
        title: SECTION_BY_KIND[kind] || "Learned memories",
        lines: rows.map((memory) => {
          const confidence = Number.isFinite(memory.confidence) ? ` (${Math.round(memory.confidence * 100)}%)` : "";
          return truncateLearningLine(`- ${memory.content}${confidence}`, options.lineMaxChars);
        }),
      };
    });
  const maxChars = Math.max(256, Number(options.maxChars) || AGENT_LEARNING_CONTEXT_MAX_CHARS);
  let omitted = 0;
  let rendered = renderLearningSections(sections, omitted);
  while (rendered.length > maxChars && sections.some((section) => section.lines.length)) {
    const last = [...sections].reverse().find((section) => section.lines.length);
    last.lines.pop();
    omitted += 1;
    rendered = renderLearningSections(sections, omitted);
  }
  return rendered.length > maxChars ? truncateLearningLine(rendered, maxChars) : rendered;
}
