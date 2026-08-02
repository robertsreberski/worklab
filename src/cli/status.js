// src/cli/status.js
import {
  loadConfig,
  serviceStatus,
} from "../core/index.js";
import { applyConfigArgs } from "./args.js";
import {
  coordinatorHealthMatchesClaim,
  readCoordinatorHealth,
} from "./coordinator-control.js";
import { inspectCoordinatorStateOnce } from "./coordinator-state.js";
import { inspectServiceRuntime, serviceRuntimeProblems } from "./service-runtime.js";

export async function status(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  const svc = await serviceStatus();
  const runtime = inspectServiceRuntime(config);
  console.log(`service: ${JSON.stringify({ ...svc, runtime, problems: serviceRuntimeProblems(runtime) })}`);

  const coordinator = inspectCoordinatorStateOnce({ dataDir: config.dataDir });
  if (coordinator.status === "not_running") {
    console.log("coordinator: not running");
    return;
  }
  if (coordinator.status === "stale_pid") {
    console.log(`coordinator: stale pid file${coordinator.pid ? ` (pid ${coordinator.pid})` : ""}`);
    return;
  }
  const response = await readCoordinatorHealth({ config });
  if (coordinator.status === "ownership_busy") {
    if (!coordinatorHealthMatchesClaim(response.health, coordinator)) {
      console.log("coordinator: lifetime lock active; ownership identity is not yet confirmed");
      return;
    }
    console.log(`coordinator: running pid=${coordinator.pid} identity=verified port=${config.port} health=${JSON.stringify(response.health)}`);
    return;
  }
  if (response.status === "ok" && Number(response.health?.pid) === coordinator.pid) {
    console.log(`coordinator: running pid=${coordinator.pid} identity=legacy port=${config.port} health=${JSON.stringify(response.health)}`);
  } else {
    console.log(`coordinator: legacy pid=${coordinator.pid} alive but health check failed`);
  }
}
