// Cross-platform probe for the launchd / systemd-user host service that
// runs `worklab serve` in the background. The CLI's install-service module
// owns install/uninstall; this status probe lives in core/ so the MCP admin
// tool surface (mcp/admin/tools/index.js) can expose it without a back-import
// into the CLI layer.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

export async function serviceStatus() {
  const p = platform();
  if (p === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", "ai.worklab.plist");
    return { platform: p, file, installed: existsSync(file), scope: `gui/${userInfo().uid}` };
  }
  if (p === "linux") {
    const file = join(homedir(), ".config", "systemd", "user", "worklab.service");
    let active = null;
    try {
      active = execFileSync("systemctl", ["--user", "is-active", "worklab"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      active = "inactive";
    }
    return { platform: p, file, installed: existsSync(file), active };
  }
  return { platform: p, installed: false };
}
