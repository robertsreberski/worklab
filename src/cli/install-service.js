import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/index.js";
import { applyConfigArgs } from "./args.js";

const LAUNCHD_LABEL = "ai.worklab";

function launchdDomain() {
  return `gui/${userInfo().uid}`;
}

function launchdTarget() {
  return `${launchdDomain()}/${LAUNCHD_LABEL}`;
}

function launchdFilePath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function systemdEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serviceEnv({ dataDir, host, port, workspace, logLevel, timezone }) {
  return {
    WORKLAB_DATA_DIR: dataDir,
    WORKLAB_HOST: host,
    WORKLAB_PORT: port === undefined ? undefined : String(port),
    WORKLAB_WORKSPACE: workspace,
    WORKLAB_LOG_LEVEL: logLevel,
    WORKLAB_TIMEZONE: timezone,
    PATH: process.env.PATH || "",
  };
}

function launchdEnvXml(env) {
  const entries = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("\n");
  return entries ? `  <key>EnvironmentVariables</key>\n  <dict>\n${entries}\n  </dict>\n` : "";
}

function systemdEnvLines(env) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `Environment="${key}=${systemdEscape(value)}"`)
    .join("\n");
}

export function serviceParams(config = loadConfig()) {
  const cli = join(config.repoRoot, "src", "cli", "index.js");
  return {
    node: process.execPath,
    cli,
    cwd: config.repoRoot,
    dataDir: config.dataDir,
    env: serviceEnv(config),
  };
}

export function launchdPlist({ node, cli, cwd, dataDir, env = serviceEnv({ dataDir }) }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.worklab</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
${launchdEnvXml(env)}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(dataDir, "logs", "worklab.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(dataDir, "logs", "worklab.err.log")}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, cli, cwd, dataDir, env = serviceEnv({ dataDir }) }) {
  const envLines = systemdEnvLines(env);
  return `[Unit]
Description=Worklab

[Service]
Type=simple
WorkingDirectory=${cwd}
${envLines ? `${envLines}\n` : ""}ExecStart=${node} ${cli} serve
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

export function serviceFilePath(p = platform()) {
  if (p === "darwin") return launchdFilePath();
  if (p === "linux") return join(homedir(), ".config", "systemd", "user", "worklab.service");
  return null;
}

export function renderServiceFile(config = loadConfig()) {
  const params = serviceParams(config);
  const p = platform();
  if (p === "darwin") return launchdPlist(params);
  if (p === "linux") return systemdUnit(params);
  throw new Error(`service is not supported on ${p}`);
}

export async function ensureServiceInstalled({ config = loadConfig(), dry = false } = {}) {
  const dataDir = config.dataDir;
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const params = serviceParams(config);
  const p = platform();

  if (p === "darwin") {
    const dir = join(homedir(), "Library", "LaunchAgents");
    const file = launchdFilePath();
    const content = launchdPlist(params);
    if (dry) return { platform: p, file, content, installed: false };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    return { platform: p, file, installed: true };
  }

  if (p === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    const file = join(dir, "worklab.service");
    const content = systemdUnit(params);
    if (dry) return { platform: p, file, content, installed: false };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    return { platform: p, file, installed: true };
  }

  throw new Error(`service is not supported on ${p}`);
}

function bootstrapLaunchdService(file) {
  const domain = launchdDomain();
  const target = launchdTarget();
  try { execFileSync("launchctl", ["bootout", domain, file], { stdio: "ignore" }); } catch { /* not loaded */ }
  execFileSync("launchctl", ["bootstrap", domain, file], { stdio: "inherit" });
  execFileSync("launchctl", ["enable", target], { stdio: "ignore" });
  execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
}

export async function startUserService({ config = loadConfig() } = {}) {
  const p = platform();
  const file = serviceFilePath(p);
  if (p === "darwin") {
    bootstrapLaunchdService(file);
    return { platform: p, file };
  }

  if (p === "linux") {
    execFileSync("systemctl", ["--user", "enable", "--now", "worklab"], { stdio: "inherit" });
    return { platform: p, file };
  }

  throw new Error(`service start is not supported on ${p}`);
}

export async function restartUserService({ config = loadConfig() } = {}) {
  const p = platform();
  const file = serviceFilePath(p);
  if (p === "darwin") {
    bootstrapLaunchdService(file);
    return { platform: p, file };
  }
  if (p === "linux") {
    execFileSync("systemctl", ["--user", "restart", "worklab"], { stdio: "inherit" });
    return { platform: p, file };
  }
  throw new Error(`service restart is not supported on ${p}`);
}

export async function stopUserService() {
  const p = platform();
  const file = serviceFilePath(p);
  if (p === "darwin") {
    if (!existsSync(file)) throw new Error(`launchd service is not installed: ${file}`);
    execFileSync("launchctl", ["unload", "-w", file], { stdio: "ignore" });
    return { platform: p, file };
  }
  if (p === "linux") {
    execFileSync("systemctl", ["--user", "stop", "worklab"], { stdio: "inherit" });
    return { platform: p, file };
  }
  throw new Error(`service stop is not supported on ${p}`);
}

export async function installService(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  if (dryRun(args)) {
    console.log(renderServiceFile(config));
    return;
  }
  const installed = await ensureServiceInstalled({ config });
  await startUserService({ config });
  console.log(`installed ${installed.platform === "darwin" ? "launchd" : "systemd user"} service: ${installed.file}`);
}

// serviceStatus moved to src/core/host-service-status.js so the MCP admin
// surface can import it without a cli back-reference. Re-exported here for
// any straggling caller.
export { serviceStatus } from "../core/index.js";
