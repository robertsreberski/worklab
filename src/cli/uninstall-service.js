import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

function dryRun(args) {
  return args.includes("--dry-run");
}

export async function uninstallService(args = []) {
  const p = platform();
  if (p === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", "ai.worklab.plist");
    if (dryRun(args)) {
      console.log(`launchctl unload -w ${file}`);
      console.log(`rm -f ${file}`);
      return;
    }
    if (existsSync(file)) {
      try { execFileSync("launchctl", ["unload", "-w", file], { stdio: "ignore" }); } catch { /* not loaded */ }
      unlinkSync(file);
    }
    console.log(`uninstalled launchd service: ${file}`);
    return;
  }

  if (p === "linux") {
    const file = join(homedir(), ".config", "systemd", "user", "worklab.service");
    if (dryRun(args)) {
      console.log("systemctl --user disable --now worklab");
      console.log(`rm -f ${file}`);
      console.log("systemctl --user daemon-reload");
      return;
    }
    try { execFileSync("systemctl", ["--user", "disable", "--now", "worklab"], { stdio: "inherit" }); } catch { /* not installed */ }
    if (existsSync(file)) unlinkSync(file);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    console.log(`uninstalled systemd user service: ${file}`);
    return;
  }

  throw new Error(`uninstall-service is not supported on ${p}`);
}
