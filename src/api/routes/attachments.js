import express from "express";
import { existsSync, statSync } from "node:fs";
import {
  attachmentFromRow,
  attachmentStoredFilePath,
  createAttachmentUpload,
} from "../../core/index.js";
import { getTaskAttachmentById } from "../../core/db/queries/task-attachments.js";

function routeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: {
      code: error.code || (status === 500 ? "internal" : "error"),
      message: error.message || "failed",
    },
  });
}

export function registerAttachmentRoutes(app, { db, dataDir }) {
  app.post("/api/attachments/uploads", express.raw({ type: "image/*", limit: "10mb" }), (req, res) => {
    try {
      const rawFilename = req.get("X-Attachment-Filename") || req.query.filename || "clipboard-image.png";
      let filename;
      try {
        filename = decodeURIComponent(String(rawFilename));
      } catch {
        filename = String(rawFilename);
      }
      const upload = createAttachmentUpload({
        dataDir,
        buffer: req.body,
        filename,
        mimeType: String(req.get("content-type") || "").split(";")[0],
      });
      res.status(201).json({ upload });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/tasks/:taskId/attachments/:attachmentId/file", (req, res, next) => {
    try {
      const row = getTaskAttachmentById(db, req.params.taskId, req.params.attachmentId);
      const attachment = attachmentFromRow(row);
      if (!attachment || attachment.kind !== "upload") {
        throw routeError(404, "not_found", "attachment file not found");
      }
      const filePath = attachmentStoredFilePath({ dataDir, attachment });
      if (!filePath) throw routeError(403, "forbidden", "attachment file path is outside attachment storage");
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        throw routeError(404, "not_found", "attachment file not found");
      }
      res.type(attachment.mime_type || "application/octet-stream");
      return res.sendFile(filePath, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
