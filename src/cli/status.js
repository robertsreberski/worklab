// src/cli/status.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";

export async function status() {
  const config = loadConfig();
  const pidFile = join(config.dataDir, ".coordinator.pid");
  if (!existsSync(pidFile)) {
    console.log("coordinator: not running");
    return;
  }
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }

  if (!alive) {
    console.log(`coordinator: stale pid file (pid ${pid} not alive)`);
    return;
  }

  try {
    const res = await fetch(`http://localhost:${config.port}/api/health`);
    const json = await res.json();
    console.log(`coordinator: running pid=${pid} port=${config.port} health=${JSON.stringify(json)}`);
  } catch (err) {
    console.log(`coordinator: pid=${pid} alive but health check failed: ${err.message}`);
  }
}
