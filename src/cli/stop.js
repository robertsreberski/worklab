// src/cli/stop.js
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/index.js";
import { parseCoordinatorPid } from "../core/process/index.js";
import { stopUserService } from "./install-service.js";
import { applyConfigArgs } from "./args.js";

export async function stop(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  try {
    const stopped = await stopUserService({ config });
    console.log(`stopped ${stopped.platform} service: ${stopped.file}`);
    return;
  } catch (err) {
    console.log(`service stop unavailable; falling back to pid file: ${err.message}`);
  }

  const pidFile = join(config.dataDir, ".coordinator.pid");
  if (!existsSync(pidFile)) {
    console.log("coordinator not running (no pid file)");
    return;
  }
  const pid = parseCoordinatorPid(readFileSync(pidFile, "utf8"));
  if (!pid) {
    console.log("coordinator not running (invalid pid file); cleaning stale pid file");
    try { unlinkSync(pidFile); } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to ${pid}`);
  } catch (err) {
    console.log(`process ${pid} not found; cleaning stale pid file`);
    try { unlinkSync(pidFile); } catch {}
  }
}
