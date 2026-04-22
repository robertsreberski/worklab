import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { openDb } from "../core/db.js";

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

export async function backup(args = []) {
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 ? args[outIndex + 1] : join(homedir(), "worklab-backups");
  if (!outDir) throw new Error("--out requires a directory");
  const config = loadConfig();
  if (!existsSync(config.dataDir)) throw new Error(`data dir does not exist: ${config.dataDir}`);
  mkdirSync(outDir, { recursive: true });

  const dbPath = join(config.dataDir, "worklab.db");
  if (existsSync(dbPath)) {
    const db = openDb(dbPath);
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
  }

  const archive = join(outDir, `${timestamp()}.tar.gz`);
  execFileSync("tar", [
    "--exclude=logs",
    "--exclude=.coordinator.pid",
    "--exclude=*.db-wal",
    "--exclude=*.db-shm",
    "-czf",
    archive,
    "-C",
    config.dataDir,
    ".",
  ], { stdio: "pipe" });
  console.log(`backup: ${archive}`);
  console.log(`restore: mkdir -p ${config.dataDir} && tar -xzf ${archive} -C ${config.dataDir}`);
}
