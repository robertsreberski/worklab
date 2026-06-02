import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { serviceFilePath, serviceParams } from "./install-service.js";

const NODE_PROBE = "JSON.stringify({execPath:process.execPath,version:process.versions.node,modules:process.versions.modules})";
const SQLITE_PROBE = "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();";

function compactError(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 8)
    .join("\n")
    .slice(0, 2000);
}

export function configuredNodeFromServiceFile(content, p = platform()) {
  const text = String(content || "");
  if (p === "darwin") {
    const argsBlock = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] || "";
    const args = [...argsBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)]
      .map((match) => match[1]
        .replace(/&quot;/g, "\"")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&"));
    return args[0] || null;
  }
  if (p === "linux") {
    const line = text.split(/\r?\n/).find((entry) => entry.trim().startsWith("ExecStart="));
    const command = line ? line.replace(/^ExecStart=/, "").trim() : "";
    return command.split(/\s+/)[0] || null;
  }
  return null;
}

function readServiceNode(file, p) {
  if (!file || !existsSync(file)) return null;
  return configuredNodeFromServiceFile(readFileSync(file, "utf8"), p);
}

function nodeInfo(nodePath) {
  if (!nodePath) return { ok: false, error: "service node is not configured" };
  try {
    return {
      ok: true,
      ...JSON.parse(execFileSync(nodePath, ["-p", NODE_PROBE], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()),
    };
  } catch (err) {
    return { ok: false, error: compactError(err.stderr?.toString?.() || err.message) };
  }
}

export function nativeDependencyCheck({ nodePath, cwd }) {
  if (!nodePath) return { ok: false, error: "service node is not configured" };
  try {
    execFileSync(nodePath, ["-e", SQLITE_PROBE], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: compactError(err.stderr?.toString?.() || err.message) };
  }
}

export function inspectServiceRuntime(config) {
  const p = platform();
  const params = serviceParams(config);
  const file = serviceFilePath(p);
  const configuredNode = readServiceNode(file, p);
  return {
    platform: p,
    file,
    installed: !!(file && existsSync(file)),
    configuredNode,
    expectedNode: params.node,
    currentNode: process.execPath,
    currentVersion: process.versions.node,
    currentModules: process.versions.modules,
    configuredNodeInfo: nodeInfo(configuredNode),
    nativeDependency: nativeDependencyCheck({ nodePath: configuredNode, cwd: params.cwd }),
  };
}

export function serviceRuntimeProblems(runtime) {
  const problems = [];
  if (!runtime?.installed) return problems;
  if (!runtime.configuredNode) {
    problems.push(`service node is missing from ${runtime.file}`);
  } else if (
    runtime.configuredNode !== runtime.expectedNode
    && runtime.configuredNodeInfo?.modules
    && runtime.currentModules
    && runtime.configuredNodeInfo.modules !== runtime.currentModules
  ) {
    problems.push(`service node ${runtime.configuredNode} uses NODE_MODULE_VERSION ${runtime.configuredNodeInfo.modules}, current CLI node ${runtime.expectedNode} uses ${runtime.currentModules}`);
  }
  if (runtime.configuredNodeInfo && !runtime.configuredNodeInfo.ok) {
    problems.push(`service node cannot run: ${runtime.configuredNodeInfo.error}`);
  }
  if (runtime.nativeDependency && !runtime.nativeDependency.ok) {
    problems.push(`better-sqlite3 cannot load under service node ${runtime.configuredNode || "(missing)"}: ${runtime.nativeDependency.error}`);
  }
  return problems;
}

export function assertServiceRuntimeReady(config) {
  const runtime = inspectServiceRuntime(config);
  const problems = serviceRuntimeProblems(runtime);
  if (problems.length === 0) return runtime;
  const rebuild = `npm rebuild better-sqlite3`;
  throw new Error([
    "Worklab service runtime is not ready:",
    ...problems.map((problem) => ` - ${problem}`),
    `Run ${rebuild} with the same Node that runs worklab start/restart, or rerun worklab from the desired Node.`,
  ].join("\n"));
}

export function readTail(file, { maxBytes = 12_000, maxLines = 80 } = {}) {
  if (!file || !existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const tail = text.length > maxBytes ? text.slice(-maxBytes) : text;
  return tail.split(/\r?\n/).slice(-maxLines).join("\n").trim();
}

export function serviceErrorLogTail(config, options = {}) {
  return readTail(join(config.dataDir, "logs", "worklab.err.log"), options);
}
