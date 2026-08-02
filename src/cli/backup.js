import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig, openDb } from "../core/index.js";
import { applyConfigArgs } from "./args.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_ARCHIVE_MODE = 0o600;

// These files are credential stores, cryptographic keys, or may contain
// arbitrary inline MCP credentials. They must be recreated after restoring a
// backup instead of being copied into a portable archive.
const SECRET_ROOT_FILES = new Set([
  ".env",
  ".provider-encryption-key",
  "auth.json",
  "mcp-token",
  "pi-auth.json",
  "push-vapid.json",
]);

const OMITTED_ROOT_ENTRIES = new Set([
  ...SECRET_ROOT_FILES,
  ".coordinator.pid",
  "config",
  "logs",
  "worklab.db",
]);

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

async function createSanitizedDatabase(sourcePath, targetPath) {
  const source = openDb(sourcePath);
  try {
    source.pragma("wal_checkpoint(TRUNCATE)");
    await source.backup(targetPath);
  } finally {
    source.close();
  }

  const copy = openDb(targetPath);
  try {
    if (hasColumn(copy, "custom_providers", "api_key_encrypted")) {
      copy.prepare("UPDATE custom_providers SET api_key_encrypted = NULL").run();
    }
    if (hasColumn(copy, "push_subscriptions", "keys_json")) {
      copy.prepare("DELETE FROM push_subscriptions").run();
    }
    // Rebuild the file so removed credentials cannot survive in free pages.
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
  chmodSync(targetPath, PRIVATE_ARCHIVE_MODE);
}

function stageNonSecretConfig(dataDir, stagingDir) {
  const source = join(dataDir, "config");
  if (!existsSync(source)) return;
  cpSync(source, join(stagingDir, "config"), {
    recursive: true,
    filter(path) {
      if (path === source) return true;
      const name = basename(path);
      return name !== "mcp.json" && !SECRET_ROOT_FILES.has(name);
    },
  });
}

function outputRootEntry(dataDir, outDir, archive) {
  const relativeOut = relative(resolve(dataDir), resolve(outDir));
  if (!relativeOut) return basename(archive);
  if (relativeOut === ".." || relativeOut.startsWith(`..${sep}`) || isAbsolute(relativeOut)) return null;
  return relativeOut.split(sep)[0];
}

function backupEntries(dataDir, outDir, archive) {
  const outputEntry = outputRootEntry(dataDir, outDir, archive);
  return readdirSync(dataDir)
    .filter((name) => !OMITTED_ROOT_ENTRIES.has(name) && name !== outputEntry)
    .map((name) => `./${name}`);
}

export async function backup(args = []) {
  applyConfigArgs(args);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 ? args[outIndex + 1] : join(homedir(), "worklab-backups");
  if (!outDir) throw new Error("--out requires a directory");
  const config = loadConfig();
  if (!existsSync(config.dataDir)) throw new Error(`data dir does not exist: ${config.dataDir}`);
  mkdirSync(outDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(outDir, PRIVATE_DIRECTORY_MODE);

  const archive = join(outDir, `${timestamp()}.tar.gz`);
  const stagingDir = mkdtempSync(join(tmpdir(), "worklab-backup-"));
  chmodSync(stagingDir, PRIVATE_DIRECTORY_MODE);
  let completed = false;
  try {
    const dbPath = join(config.dataDir, "worklab.db");
    if (existsSync(dbPath)) {
      await createSanitizedDatabase(dbPath, join(stagingDir, "worklab.db"));
    }
    stageNonSecretConfig(config.dataDir, stagingDir);

    // Pre-create the destination privately. tar truncates the file without
    // widening its mode, and the final chmod defends against tar variants that
    // replace it instead.
    closeSync(openSync(archive, "w", PRIVATE_ARCHIVE_MODE));
    chmodSync(archive, PRIVATE_ARCHIVE_MODE);
    execFileSync("tar", [
      "--exclude=*.db-wal",
      "--exclude=*.db-shm",
      "-czf",
      archive,
      "-C",
      config.dataDir,
      ...backupEntries(config.dataDir, outDir, archive),
      "-C",
      stagingDir,
      ".",
    ], { stdio: "pipe" });
    chmodSync(archive, PRIVATE_ARCHIVE_MODE);
    completed = true;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    if (!completed) rmSync(archive, { force: true });
  }
  console.log(`backup: ${archive}`);
  console.log(`restore: mkdir -p ${config.dataDir} && tar -xzf ${archive} -C ${config.dataDir}`);
}
