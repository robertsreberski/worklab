// src/cli/stop.js
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";

export async function stop() {
  const config = loadConfig();
  const pidFile = join(config.dataDir, ".coordinator.pid");
  if (!existsSync(pidFile)) {
    console.log("coordinator not running (no pid file)");
    return;
  }
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to ${pid}`);
  } catch (err) {
    console.log(`process ${pid} not found; cleaning stale pid file`);
    try { unlinkSync(pidFile); } catch {}
  }
}
