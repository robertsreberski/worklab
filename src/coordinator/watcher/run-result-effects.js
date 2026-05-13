import { newCommentId } from "../../core/ids.js";
import { agentCommentBody } from "./final-text.js";
import {
  appendKbLink,
  firstKnowledgeSlugFromText,
  successfulKbWriteFromEvents,
} from "./kb-publisher.js";
import { safeParseJson } from "./run-handler.js";

export function postAgentFinalComment(db, { taskId, agentName, result, finalText, events = [] }) {
  let body = agentCommentBody(result, finalText);
  const linkedSlug = firstKnowledgeSlugFromText(body) || firstKnowledgeSlugFromText(finalText);
  const kbWrite = linkedSlug ? { wrote: true, slug: linkedSlug } : successfulKbWriteFromEvents(events);
  if (kbWrite.wrote) {
    if (kbWrite.slug) body = appendKbLink(body, kbWrite.slug);
  }
  if (!body) return;
  db.prepare(
    `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(newCommentId(), taskId, agentName, body, Date.now());
}

export function updateRunResult(db, runId, result) {
  if (!result) return;
  db.prepare(
    `UPDATE task_runs
     SET decision = ?, summary = COALESCE(summary, ?), details = COALESCE(details, ?),
         result_json = COALESCE(result_json, ?)
     WHERE id = ?`,
  ).run(result.decision || null, result.summary || null, result.details || null, JSON.stringify(result), runId);
}

export function appendRunWarning(db, runId, warning) {
  const row = db
    .prepare("SELECT warnings_json FROM task_runs WHERE id = ?")
    .get(runId);
  if (!row) return;
  const warnings = safeParseJson(row.warnings_json, []);
  warnings.push(warning);
  db.prepare("UPDATE task_runs SET warnings_json = ? WHERE id = ?")
    .run(JSON.stringify(warnings), runId);
}
