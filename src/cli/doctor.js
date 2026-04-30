// src/cli/doctor.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { openDb, runMigrations } from "../core/db.js";
import { getKeyFingerprint } from "../core/crypto.js";
import { loadMcpConfig } from "../core/mcp-config.js";
import { testEmbeddingBackend } from "../core/embeddings.js";
import { resolveRgPath } from "../core/ai-tool-helpers.js";
import { applyConfigArgs } from "./args.js";
import { inspectServiceRuntime, serviceRuntimeProblems } from "./service-runtime.js";

export async function doctor(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  const problems = [];
  let db = null;

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) problems.push(`node ${process.versions.node} < 20 required`);

  const serviceRuntime = inspectServiceRuntime(config);
  for (const problem of serviceRuntimeProblems(serviceRuntime)) problems.push(problem);

  const rgPath = resolveRgPath({ refresh: true });
  if (!rgPath) problems.push("ripgrep (rg) not found: install ripgrep on PATH or set WORKLAB_RIPGREP_PATH; agent Glob/Grep tools will fail without it");

  const dbPath = join(config.dataDir, "worklab.db");
  if (existsSync(dbPath)) {
    try {
      db = openDb(dbPath);
      try {
        runMigrations(db);
        const rows = db.pragma("integrity_check");
        if (rows[0]?.integrity_check !== "ok") problems.push(`db integrity: ${JSON.stringify(rows)}`);
      } catch (err) {
        problems.push(`db check failed: ${err.message}`);
      }
    } catch (err) {
      problems.push(`db open failed: ${err.message}`);
    }
  }

  const mcp = join(config.dataDir, "config/mcp.json");
  if (existsSync(mcp)) {
    try {
      JSON.parse(readFileSync(mcp, "utf8"));
      loadMcpConfig(config.dataDir);
    }
    catch (err) { problems.push(`mcp.json invalid: ${err.message}`); }
  }

  try { getKeyFingerprint({ dataDir: config.dataDir }); }
  catch (err) { problems.push(`provider encryption key unavailable: ${err.message}`); }

  if (db) {
    try {
      const embedding = await testEmbeddingBackend({ db, dataDir: config.dataDir });
      if (!embedding.ok) problems.push(`embedding backend unreachable (${embedding.model}): ${embedding.error}`);
    } catch (err) {
      problems.push(`embedding backend check failed: ${err.message}`);
    } finally {
      db.close();
    }
  }

  if (problems.length === 0) console.log("doctor: OK");
  else { console.log("doctor: ISSUES"); for (const p of problems) console.log(` - ${p}`); }
}
