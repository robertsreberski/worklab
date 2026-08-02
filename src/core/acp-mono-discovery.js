import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export const MONO_ACP_DISCOVERY_SCHEMA = "mono-agent.acp-discovery.v1";
export const MONO_ACP_SOURCE_SCHEMA = "mono-agent.acp-source.v1";
export const MONO_ACP_BRIDGE_VERSION = 1;
export const ACP_PROTOCOL_VERSION = 1;

const VALID_HEALTH = new Set(["running", "stale", "stopped", "failed"]);
const VALID_PROMPT_CONTENT = new Set(["text", "resource_link"]);

export class MonoAcpDiscoveryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "MonoAcpDiscoveryError";
    this.code = code;
  }
}

function cleanText(value, { required = false, max = 4096 } = {}) {
  if (typeof value !== "string") {
    if (required) throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent discovery returned a non-string field");
    return null;
  }
  const text = value.trim();
  if (!text && required) throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent discovery returned an empty field");
  return text.slice(0, max);
}

function exactVersion(value, expected, field) {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new MonoAcpDiscoveryError("incompatible_discovery", `unsupported mono-agent ${field}: ${String(value)}`);
  }
  return value;
}

function sanitizeSource(source) {
  if (!source || typeof source !== "object" || source.schema !== MONO_ACP_SOURCE_SCHEMA) {
    throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent returned an invalid ACP source descriptor");
  }
  const workspacePath = cleanText(source.workspace?.path, { required: true, max: 16_384 });
  if (!isAbsolute(workspacePath)) {
    throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent ACP source workspace must be absolute");
  }
  const health = VALID_HEALTH.has(source.health) ? source.health : "failed";
  const promptContent = Array.isArray(source.constraints?.promptContent)
    ? [...new Set(source.constraints.promptContent.filter((entry) => VALID_PROMPT_CONTENT.has(entry)))]
    : [];
  if (!promptContent.includes("text") || !promptContent.includes("resource_link")) {
    throw new MonoAcpDiscoveryError("incompatible_discovery", "mono-agent ACP source lacks baseline text/resource-link prompt support");
  }
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.slice(0, 32).map((warning) => cleanText(warning, { max: 1024 })).filter(Boolean)
    : [];
  return {
    schema: MONO_ACP_SOURCE_SCHEMA,
    bridgeVersion: exactVersion(source.bridgeVersion, MONO_ACP_BRIDGE_VERSION, "bridge version"),
    protocolVersion: exactVersion(source.protocolVersion, ACP_PROTOCOL_VERSION, "protocol version"),
    installedVersion: cleanText(source.installedVersion, { required: true, max: 128 }),
    sourceId: cleanText(source.sourceId, { required: true, max: 1024 }),
    label: cleanText(source.label, { required: true, max: 1024 }),
    health,
    compatible: source.compatible === true,
    workspace: { path: resolve(workspacePath), owner: "agent" },
    ownership: { configuration: "agent", workspace: "agent", mcp: "agent" },
    constraints: {
      promptContent,
      clientMcp: false,
      clientFilesystem: false,
      clientTerminal: false,
      attachments: false,
      additionalDirectories: false,
    },
    warnings,
  };
}

function runDiscovery(command, { timeoutMs, maxBuffer, execFileImpl, env }) {
  return new Promise((resolvePromise, reject) => {
    execFileImpl(command, ["bridge", "acp", "--discover"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      shell: false,
      env,
    }, (err, stdout) => {
      if (err) {
        const reason = err.killed || err.code === "ETIMEDOUT" ? "timed out" : "failed";
        reject(new MonoAcpDiscoveryError(
          reason === "timed out" ? "discovery_timeout" : "discovery_failed",
          `mono-agent ACP discovery ${reason}`,
          { cause: err },
        ));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function discoverMonoAcpAgents({
  command = process.env.WORKLAB_MONO_AGENT_BIN || "mono-agent",
  timeoutMs = 5_000,
  maxBuffer = 1024 * 1024,
  execFileImpl = execFile,
  env = process.env,
} = {}) {
  const stdout = await runDiscovery(command, { timeoutMs, maxBuffer, execFileImpl, env });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent ACP discovery did not return JSON", { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || parsed.schema !== MONO_ACP_DISCOVERY_SCHEMA) {
    throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent returned an unknown ACP discovery schema");
  }
  exactVersion(parsed.bridgeVersion, MONO_ACP_BRIDGE_VERSION, "bridge version");
  exactVersion(parsed.protocolVersion, ACP_PROTOCOL_VERSION, "protocol version");
  if (!Array.isArray(parsed.sources) || parsed.sources.length > 256) {
    throw new MonoAcpDiscoveryError("invalid_discovery", "mono-agent returned an invalid ACP source list");
  }
  return {
    schema: MONO_ACP_DISCOVERY_SCHEMA,
    bridgeVersion: MONO_ACP_BRIDGE_VERSION,
    protocolVersion: ACP_PROTOCOL_VERSION,
    sources: parsed.sources.map(sanitizeSource),
  };
}
