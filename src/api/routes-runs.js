import { legacyRunStatusToProcessStatus } from "../core/state-machine.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function registerRunRoutes(app, { db, broker, dataDir }) {
  app.get("/api/runs/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const processStatus = row.status !== "running" && row.process_status === "running"
      ? legacyRunStatusToProcessStatus(row.status)
      : row.process_status;
    const run = {
      ...row,
      process_status: processStatus,
      artifact_paths: JSON.parse(row.artifact_paths_json || "[]"),
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
    const logRow = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(req.params.id);
    const log = logRow ? { ...logRow, events: JSON.parse(logRow.events || "[]") } : null;
    res.json({ run, log });
  });

  app.get("/api/runs/:id/raw-log", (req, res) => {
    const row = db.prepare("SELECT raw_output_path FROM task_runs WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    if (!row.raw_output_path) {
      return res.status(404).json({ error: { code: "not_found", message: "raw log not available" } });
    }
    const rawPath = resolve(row.raw_output_path);
    if (dataDir) {
      const root = resolve(dataDir);
      if (!rawPath.startsWith(`${root}/`) && rawPath !== root) {
        return res.status(403).json({ error: { code: "forbidden", message: "raw log path is outside data dir" } });
      }
    }
    if (!existsSync(rawPath)) {
      return res.status(404).json({ error: { code: "not_found", message: "raw log file not found" } });
    }
    res.type("text/plain").send(readFileSync(rawPath, "utf8"));
  });

  app.get("/api/runs/:id/stream", (req, res) => {
    broker.subscribe(req.params.id, res);
  });
}
