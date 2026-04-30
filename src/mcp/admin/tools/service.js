// Worklab service / health admin tools.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { serviceStatus } from "../../../core/index.js";
import { tool } from "../../shared/schema-helpers.js";
import { apiRequest } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_status", "Return Worklab health, service metadata, and configuration summary."),
  tool("worklab_service_status", "Return per-user service installation and active-state metadata."),
  tool("worklab_service_restart", "Request a Worklab service restart."),
  tool("worklab_service_stop", "Request a Worklab service stop."),
];

function queueCliCommand(config, command) {
  const cli = join(config.repoRoot, "src", "cli", "index.js");
  const child = spawn(process.execPath, [cli, command], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WORKLAB_DATA_DIR: config.dataDir },
  });
  child.unref();
  return { queued: true, command, pid: child.pid };
}

export function buildHandlers(client, { config }) {
  return {
    worklab_status: async () => ({
      health: await apiRequest(client, "GET", "/api/health"),
      service: await serviceStatus(),
      config: config ? {
        host: config.host,
        port: config.port,
        dataDir: config.dataDir,
        workspace: config.workspace,
        repoRoot: config.repoRoot,
      } : null,
    }),
    worklab_service_status: async () => serviceStatus(),
    worklab_service_restart: async () => queueCliCommand(config, "restart"),
    worklab_service_stop: async () => queueCliCommand(config, "stop"),
  };
}
