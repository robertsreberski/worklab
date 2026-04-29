// src/cli/status.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, worklabBaseUrl } from "../core/config.js";
import { serviceStatus } from "./install-service.js";
import { applyConfigArgs } from "./args.js";
import { inspectServiceRuntime, serviceRuntimeProblems } from "./service-runtime.js";

export async function status(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  const svc = await serviceStatus();
  const runtime = inspectServiceRuntime(config);
  console.log(`service: ${JSON.stringify({ ...svc, runtime, problems: serviceRuntimeProblems(runtime) })}`);

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
    const res = await fetch(`${worklabBaseUrl(config)}/api/health`);
    const json = await res.json();
    console.log(`coordinator: running pid=${pid} port=${config.port} health=${JSON.stringify(json)}`);
  } catch (err) {
    console.log(`coordinator: pid=${pid} alive but health check failed: ${err.message}`);
  }
}
