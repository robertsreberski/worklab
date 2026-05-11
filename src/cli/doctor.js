// src/cli/doctor.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getKeyFingerprint,
  loadConfig,
  loadMcpConfig,
  openDb,
  runMigrations,
  testEmbeddingBackend,
} from "../core/index.js";
// resolveRgPath transitively loads src/agent/tools/glob.js whose module
// initialization calls promisify(execFile); pulling it through the core
// barrel breaks tests that mock node:child_process partially. Keep this
// import deep so doctor.js is the only loader of that module path.
import { resolveRgPath } from "@worklab/agent-runtime/agent/tools/index.js";
import { configureToolRuntime } from "@worklab/agent-runtime/agent/tools/shared/runtime-context.js";
import { applyConfigArgs } from "./args.js";
import { inspectServiceRuntime, serviceRuntimeProblems } from "./service-runtime.js";

export async function doctor(args = []) {
  if (args[0] === "performance") {
    applyConfigArgs(args.slice(1));
    const { doctorPerformance } = await import("./performance-doctor.js");
    return doctorPerformance(args.slice(1));
  }

  applyConfigArgs(args);
  const config = loadConfig();
  const problems = [];
  let db = null;

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) problems.push(`node ${process.versions.node} < 20 required`);

  const serviceRuntime = inspectServiceRuntime(config);
  for (const problem of serviceRuntimeProblems(serviceRuntime)) problems.push(problem);

  // Bridge WORKLAB_RIPGREP_PATH into the package's tool runtime before probing.
  // The package no longer reads worklab-specific env vars (Phase 3 of the
  // extraction), so doctor — which runs outside the worker — has to wire the
  // env through the same way src/worker.js does at boot.
  configureToolRuntime({ ripgrepPath: process.env.WORKLAB_RIPGREP_PATH || null });

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
