import { resolveProjectRow, resolveTaskRow, suggestLocalPaths } from "../../core/index.js";
import { enrichTask, rowToTask } from "./tasks/serialization.js";

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
}
