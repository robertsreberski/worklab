import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { newAttachmentId, newAttachmentUploadId } from "./ids.js";
import {
  deleteTaskInstructionAttachmentsExcept,
  insertTaskAttachment,
  listAttachmentsByCommentIds,
  listTaskInstructionAttachments,
} from "./db/queries/task-attachments.js";

export const TASK_ATTACHMENT_OWNER_INSTRUCTIONS = "task_instructions";
export const TASK_ATTACHMENT_OWNER_COMMENT = "comment";
export const TASK_ATTACHMENT_KINDS = ["path", "upload"];

const MAX_LABEL_CHARS = 160;
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function attachmentError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function cleanLabel(value) {
  return String(value || "").trim().slice(0, MAX_LABEL_CHARS);
}

function safeFilename(value, fallback = "attachment") {
  const raw = String(value || "").trim();
  const base = basename(raw).replace(/[^\w .@()-]+/g, "-").replace(/\s+/g, " ").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 120) : fallback;
}

function expandPathText(value, baseWorkdir) {
  const text = String(value || "").trim();
  if (!text || text.includes("\0")) {
    throw attachmentError(400, "validation", "attachment path is required");
  }
  if (text === "~") return resolve(homedir());
  if (text.startsWith("~/")) return resolve(homedir(), text.slice(2));
  if (text.startsWith("~")) {
    throw attachmentError(400, "validation", "attachment path must use an absolute path, ~/path, or relative workspace path");
  }
  if (text.startsWith("/")) return resolve(text);
  const root = baseWorkdir || process.cwd();
  return resolve(root, text);
}

function uploadRoot(dataDir) {
  return join(dataDir, "tmp", "attachment-uploads");
}

function attachmentStorageRoot(dataDir) {
  return join(dataDir, "attachments");
}

function uploadDir(dataDir, uploadId) {
  return join(uploadRoot(dataDir), uploadId);
}

function uploadMetaPath(dataDir, uploadId) {
  return join(uploadDir(dataDir, uploadId), "meta.json");
}

function cleanupExpiredUploads(dataDir, now = Date.now()) {
  if (!dataDir) return;
  const root = uploadRoot(dataDir);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const stats = statSync(dir);
      if (now - stats.mtimeMs > UPLOAD_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup races.
    }
  }
}

function readUploadMeta(dataDir, uploadId) {
  const id = String(uploadId || "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw attachmentError(400, "validation", "upload_id is invalid");
  }
  const metaPath = uploadMetaPath(dataDir, id);
  if (!existsSync(metaPath)) {
    throw attachmentError(400, "validation", `attachment upload not found: ${id}`);
  }
  const meta = parseJson(readFileSync(metaPath, "utf8"), null);
  if (!meta?.path || !existsSync(meta.path)) {
    throw attachmentError(400, "validation", `attachment upload file missing: ${id}`);
  }
  return meta;
}

function storedPathFor({ taskId, attachmentId, filename }) {
  return join("attachments", "tasks", taskId, attachmentId, filename).split(sep).join("/");
}

function metadataJson(value) {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

function normalizeExistingAttachment(input, existingById) {
  const id = typeof input?.id === "string" ? input.id.trim() : "";
  if (!id) return null;
  const existing = existingById.get(id);
  if (!existing) {
    throw attachmentError(400, "validation", `attachment not found: ${id}`);
  }
  return existing;
}

function attachmentRowFromInput({ input, taskId, commentId = null, ownerType, baseWorkdir, dataDir, existingById = new Map(), now = Date.now() }) {
  const existing = normalizeExistingAttachment(input, existingById);
  if (existing) return { keepId: existing.id, row: existing };

  const kind = String(input?.kind || "").trim();
  if (!TASK_ATTACHMENT_KINDS.includes(kind)) {
    throw attachmentError(400, "validation", "attachment kind must be path or upload");
  }
  const id = newAttachmentId();
  const label = cleanLabel(input.label);

  if (kind === "path") {
    const pathText = String(input.path ?? input.path_text ?? "").trim();
    const absolutePath = expandPathText(pathText, baseWorkdir);
    return {
      row: {
        id,
        task_id: taskId,
        comment_id: commentId,
        owner_type: ownerType,
        kind: "path",
        source: "path",
        label,
        path_text: pathText,
        absolute_path: absolutePath,
        filename: null,
        mime_type: null,
        size_bytes: null,
        stored_path: null,
        metadata_json: metadataJson({}),
        created_at: now,
      },
    };
  }

  if (!dataDir) throw attachmentError(501, "not_configured", "data directory is required for uploaded attachments");
  const upload = readUploadMeta(dataDir, input.upload_id);
  const filename = safeFilename(input.filename || upload.filename, "clipboard-image.png");
  const storedPath = storedPathFor({ taskId, attachmentId: id, filename });
  const absoluteStoredPath = join(dataDir, storedPath);
  mkdirSync(dirname(absoluteStoredPath), { recursive: true });
  renameSync(upload.path, absoluteStoredPath);
  rmSync(dirname(upload.path), { recursive: true, force: true });
  return {
    row: {
      id,
      task_id: taskId,
      comment_id: commentId,
      owner_type: ownerType,
      kind: "upload",
      source: upload.source || "pasted_image",
      label: label || cleanLabel(upload.label),
      path_text: null,
      absolute_path: null,
      filename,
      mime_type: upload.mime_type || "application/octet-stream",
      size_bytes: upload.size_bytes ?? null,
      stored_path: storedPath,
      metadata_json: metadataJson({ original_filename: upload.filename || filename }),
      created_at: now,
    },
  };
}

export function attachmentFromRow(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    task_id: row.task_id,
    comment_id: row.comment_id || null,
    owner_type: row.owner_type,
    kind: row.kind,
    source: row.source || row.kind,
    label: row.label || "",
    path_text: row.path_text || null,
    absolute_path: row.absolute_path || null,
    filename: row.filename || null,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes ?? null,
    stored_path: row.stored_path || null,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
  };
  if (out.kind === "upload" && out.stored_path) {
    out.href = `/api/tasks/${encodeURIComponent(out.task_id)}/attachments/${encodeURIComponent(out.id)}/file`;
  }
  return out;
}

export function attachCommentAttachments(db, comments = []) {
  if (!comments.length) return comments;
  const rows = listAttachmentsByCommentIds(db, comments.map((comment) => comment.id));
  const byComment = new Map();
  for (const row of rows) {
    const list = byComment.get(row.comment_id) || [];
    list.push(attachmentFromRow(row));
    byComment.set(row.comment_id, list);
  }
  return comments.map((comment) => ({
    ...comment,
    attachments: byComment.get(comment.id) || [],
  }));
}

export function taskInstructionAttachments(db, taskId) {
  return listTaskInstructionAttachments(db, taskId).map(attachmentFromRow);
}

export function replaceTaskInstructionAttachments(db, {
  taskId,
  attachments = [],
  baseWorkdir,
  dataDir,
  now = Date.now(),
}) {
  const inputs = Array.isArray(attachments) ? attachments : [];
  const existing = listTaskInstructionAttachments(db, taskId);
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const keepIds = [];
  const rowsToInsert = [];
  for (const input of inputs) {
    const normalized = attachmentRowFromInput({
      input,
      taskId,
      ownerType: TASK_ATTACHMENT_OWNER_INSTRUCTIONS,
      baseWorkdir,
      dataDir,
      existingById,
      now,
    });
    if (normalized.keepId) keepIds.push(normalized.keepId);
    else rowsToInsert.push(normalized.row);
  }
  deleteTaskInstructionAttachmentsExcept(db, taskId, keepIds);
  for (const row of rowsToInsert) insertTaskAttachment(db, row);
  return taskInstructionAttachments(db, taskId);
}

export function insertCommentAttachments(db, {
  taskId,
  commentId,
  attachments = [],
  baseWorkdir,
  dataDir,
  now = Date.now(),
}) {
  const inputs = Array.isArray(attachments) ? attachments : [];
  const rows = [];
  for (const input of inputs) {
    rows.push(attachmentRowFromInput({
      input,
      taskId,
      commentId,
      ownerType: TASK_ATTACHMENT_OWNER_COMMENT,
      baseWorkdir,
      dataDir,
      now,
    }).row);
  }
  for (const row of rows) insertTaskAttachment(db, row);
  return rows.map(attachmentFromRow);
}

export function createAttachmentUpload({ dataDir, buffer, filename, mimeType, now = Date.now() }) {
  if (!dataDir) throw attachmentError(501, "not_configured", "data directory is required for uploaded attachments");
  if (!mimeType || !String(mimeType).toLowerCase().startsWith("image/")) {
    throw attachmentError(400, "validation", "only image uploads are supported");
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!bytes.length) throw attachmentError(400, "validation", "upload body is required");
  cleanupExpiredUploads(dataDir, now);
  const id = newAttachmentUploadId();
  const safeName = safeFilename(filename, `clipboard-image${extname(filename || "") || ".png"}`);
  const dir = uploadDir(dataDir, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeName);
  writeFileSync(path, bytes);
  const meta = {
    id,
    filename: safeName,
    mime_type: mimeType,
    size_bytes: bytes.length,
    source: "pasted_image",
    path,
    created_at: now,
  };
  writeFileSync(uploadMetaPath(dataDir, id), JSON.stringify(meta, null, 2));
  return {
    id,
    filename: safeName,
    mime_type: mimeType,
    size_bytes: bytes.length,
    source: "pasted_image",
    created_at: now,
  };
}

export function attachmentStoredFilePath({ dataDir, attachment }) {
  if (!dataDir || !attachment?.stored_path) return null;
  const root = resolve(attachmentStorageRoot(dataDir));
  const target = resolve(dataDir, attachment.stored_path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  return target;
}

export function formatAttachmentsForPrompt(attachments = [], { dataDir = null } = {}) {
  const list = (attachments || []).filter(Boolean);
  if (!list.length) return "";
  const lines = ["**Attachments:**"];
  for (const attachment of list) {
    const label = attachment.label ? `${attachment.label}: ` : "";
    if (attachment.kind === "path") {
      lines.push(`- ${label}path \`${attachment.path_text || attachment.absolute_path}\`${attachment.absolute_path ? ` (absolute: \`${attachment.absolute_path}\`)` : ""}`);
    } else {
      const stored = attachment.stored_path
        ? (dataDir ? join(dataDir, attachment.stored_path) : attachment.stored_path)
        : "";
      const meta = [
        attachment.mime_type || "",
        attachment.size_bytes != null ? `${attachment.size_bytes} bytes` : "",
      ].filter(Boolean).join(", ");
      lines.push(`- ${label}uploaded file \`${attachment.filename || attachment.id}\`${meta ? ` (${meta})` : ""}${stored ? ` stored at \`${stored}\`` : ""}`);
    }
  }
  return lines.join("\n");
}
