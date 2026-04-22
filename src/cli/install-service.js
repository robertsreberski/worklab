import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";

export function launchdPlist({ node, cli, cwd, dataDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.worklab</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(dataDir, "logs", "worklab.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(dataDir, "logs", "worklab.err.log")}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, cli, cwd, dataDir }) {
  return `[Unit]
Description=Worklab

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${node} ${cli} start
Restart=always
RestartSec=5
StandardOutput=append:${join(dataDir, "logs", "worklab.out.log")}
StandardError=append:${join(dataDir, "logs", "worklab.err.log")}

[Install]
WantedBy=default.target
`;
}

function dryRun(args) {
  return args.includes("--dry-run");
}

export async function installService(args = []) {
  const config = loadConfig();
  const cli = join(config.repoRoot, "src", "cli", "index.js");
  const dataDir = config.dataDir;
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const params = { node: process.execPath, cli, cwd: config.repoRoot, dataDir };
  const p = platform();

  if (p === "darwin") {
    const dir = join(homedir(), "Library", "LaunchAgents");
    const file = join(dir, "ai.worklab.plist");
    const content = launchdPlist(params);
    if (dryRun(args)) {
      console.log(content);
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    try { execFileSync("launchctl", ["unload", "-w", file], { stdio: "ignore" }); } catch { /* not loaded */ }
    execFileSync("launchctl", ["load", "-w", file], { stdio: "inherit" });
    console.log(`installed launchd service: ${file}`);
    return;
  }

  if (p === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    const file = join(dir, "worklab.service");
    const content = systemdUnit(params);
    if (dryRun(args)) {
      console.log(content);
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "worklab"], { stdio: "inherit" });
    console.log(`installed systemd user service: ${file}`);
    return;
  }

  throw new Error(`install-service is not supported on ${p}`);
}

export async function serviceStatus() {
  const p = platform();
  if (p === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", "ai.worklab.plist");
    return { platform: p, file, installed: existsSync(file) };
  }
  if (p === "linux") {
    const file = join(homedir(), ".config", "systemd", "user", "worklab.service");
    return { platform: p, file, installed: existsSync(file) };
  }
  return { platform: p, installed: false };
}
