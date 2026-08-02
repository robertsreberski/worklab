import { loadConfig } from "../core/index.js";
import { stopUserService } from "./install-service.js";
import { applyConfigArgs } from "./args.js";
import { gracefulStopCoordinator } from "./service-drain.js";

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

  const result = await gracefulStopCoordinator({ config, timeoutMs: 0 });
  if (result.status === "timed_out" || result.status === "exited") {
    console.log(result.method === "control"
      ? `requested authenticated shutdown from coordinator ${result.pid}`
      : `sent SIGTERM to legacy coordinator ${result.pid}`);
  } else if (result.status === "not_running") {
    console.log("coordinator not running (no pid file)");
  } else if (result.status === "stale_pid") {
    console.log(`coordinator not running (stale pid${result.pid ? ` ${result.pid}` : ""}); cleaned stale pid file`);
  } else {
    console.log("coordinator ownership is active but its PID claim is not stable; no signal sent");
  }
}
