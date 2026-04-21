// src/cli/doctor.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { openDb } from "../core/db.js";

export async function doctor() {
  const config = loadConfig();
  const problems = [];

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) problems.push(`node ${process.versions.node} < 20 required`);

  const dbPath = join(config.dataDir, "worklab.db");
  if (existsSync(dbPath)) {
    const db = openDb(dbPath);
    try {
      const rows = db.pragma("integrity_check");
      if (rows[0]?.integrity_check !== "ok") problems.push(`db integrity: ${JSON.stringify(rows)}`);
    } finally { db.close(); }
  }

  const mcp = join(config.dataDir, "config/mcp.json");
  if (existsSync(mcp)) {
    try { JSON.parse(readFileSync(mcp, "utf8")); }
    catch (err) { problems.push(`mcp.json invalid: ${err.message}`); }
  }

  if (problems.length === 0) console.log("doctor: OK");
  else { console.log("doctor: ISSUES"); for (const p of problems) console.log(` - ${p}`); }
}
