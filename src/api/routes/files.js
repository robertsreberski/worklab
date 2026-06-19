import fs from "node:fs";
import path from "node:path";

import { resolveProjectRow, resolveTaskRow, suggestLocalPaths } from "../../core/index.js";
import { enrichTask, rowToTask } from "./tasks/serialization.js";

const MAX_READ_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function sendRouteError(res, error) {
  res.status(error.status || 500).json({
    error: {
      code: error.code || "error",
      message: error.message || "failed",
    },
  });
}

function baseWorkdirForRequest(db, config, query = {}) {
  const taskId = String(query.task_id || query.task || "").trim();
  if (taskId) {
    const task = resolveTaskRow(db, taskId);
    if (task) return enrichTask(db, rowToTask(task), config).effective_workdir || config?.workspace || null;
  }
  const projectId = String(query.project_id || query.project || "").trim();
  if (projectId) {
    const project = resolveProjectRow(db, projectId);
    if (project?.workdir) return project.workdir;
  }
  return config?.workspace || config?.repoRoot || process.cwd();
}

function realpathSafe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(parent, child);
  const normalizedRel = rel.split(path.sep).join("/");
  return rel === "" || (
    normalizedRel !== ".."
    && !normalizedRel.startsWith("../")
    && !path.isAbsolute(rel)
  );
}

function detectBinary(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function isPermissionError(error) {
  return error?.code === "EACCES" || error?.code === "EPERM";
}

function readPrefix(fd, readLen) {
  const buffer = Buffer.alloc(readLen);
  let bytesRead = 0;
  while (bytesRead < readLen) {
    const next = fs.readSync(fd, buffer, bytesRead, readLen - bytesRead, bytesRead);
    if (next === 0) break;
    bytesRead += next;
  }
  return buffer.subarray(0, bytesRead);
}

export function registerFileRoutes(app, { db, config }) {
  app.get("/api/files/suggest", (req, res) => {
    try {
      const prefix = String(req.query.prefix || req.query.q || "");
      const baseWorkdir = baseWorkdirForRequest(db, config, req.query);
      const results = suggestLocalPaths({
        prefix,
        baseWorkdir,
        limit: req.query.limit,
      });
      res.json({ results, base_workdir: baseWorkdir });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  app.get("/api/files/read", (req, res) => {
    try {
      const rawPath = String(req.query.path || "").trim();
      if (!rawPath) {
        return sendRouteError(res, { status: 400, code: "invalid_path", message: "path is required" });
      }
      const baseWorkdir = baseWorkdirForRequest(db, config, req.query);
      if (!baseWorkdir) {
        return sendRouteError(res, { status: 400, code: "no_workdir", message: "workdir could not be resolved" });
      }
      const baseReal = realpathSafe(baseWorkdir) || path.resolve(baseWorkdir);
      const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseReal, rawPath);
      const resolved = realpathSafe(candidate) || path.resolve(candidate);
      if (!isInside(resolved, baseReal)) {
        return sendRouteError(res, { status: 403, code: "outside_workdir", message: "path is outside the workdir" });
      }
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch (err) {
        if (err?.code === "ENOENT") {
          return sendRouteError(res, { status: 404, code: "not_found", message: "file not found" });
        }
        if (isPermissionError(err)) {
          return sendRouteError(res, { status: 403, code: "forbidden", message: "file is not readable" });
        }
        throw err;
      }
      if (!stat.isFile()) {
        return sendRouteError(res, { status: 400, code: "not_a_file", message: "path is not a regular file" });
      }
      if (stat.size > MAX_FILE_BYTES) {
        return res.json({
          path: rawPath,
          abs_path: resolved,
          size: stat.size,
          encoding: "too_large",
          truncated: true,
          content: "",
          max_bytes: MAX_FILE_BYTES,
        });
      }
      let fd = null;
      try {
        fd = fs.openSync(resolved, "r");
        const readLen = Math.min(stat.size, MAX_READ_BYTES);
        const buffer = readPrefix(fd, readLen);
        if (detectBinary(buffer)) {
          return res.json({
            path: rawPath,
            abs_path: resolved,
            size: stat.size,
            encoding: "binary",
            truncated: stat.size > readLen,
            content: "",
            max_bytes: MAX_READ_BYTES,
          });
        }
        return res.json({
          path: rawPath,
          abs_path: resolved,
          size: stat.size,
          encoding: "utf8",
          truncated: stat.size > readLen,
          content: buffer.toString("utf8"),
          max_bytes: MAX_READ_BYTES,
        });
      } catch (err) {
        if (isPermissionError(err)) {
          return sendRouteError(res, { status: 403, code: "forbidden", message: "file is not readable" });
        }
        throw err;
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
    } catch (error) {
      sendRouteError(res, error);
    }
  });
}
