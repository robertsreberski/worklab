import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export const MONO_ACP_DISCOVERY_SCHEMA = "mono-agent.acp-discovery.v1";
export const MONO_ACP_SOURCE_SCHEMA = "mono-agent.acp-source.v1";
export const MONO_ACP_BRIDGE_VERSION = 1;
export const ACP_PROTOCOL_VERSION = 1;

const VALID_HEALTH = new Set(["running", "stale", "stopped", "failed"]);
const VALID_PROMPT_CONTENT = new Set(["text", "resource_link"]);
const MONO_ACP_HOST_ENV_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "MONO_AGENT_TRACE_REGISTRY_DIR",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
]);

export class MonoAcpDiscoveryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "MonoAcpDiscoveryError";
    this.code = code;
  }
}

export function monoAcpHostEnvironment(env = process.env) {
  const selected = {};
  for (const key of MONO_ACP_HOST_ENV_KEYS) {
    if (typeof env?.[key] === "string") selected[key] = env[key];
  }
  return selected;
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

function advertisedVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MonoAcpDiscoveryError("invalid_discovery", `mono-agent returned an invalid ${field}`);
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
  if (source.constraints.clientMcp !== false
    || source.constraints.clientFilesystem !== false
    || source.constraints.clientTerminal !== false
    || source.constraints.attachments !== false
    || source.constraints.additionalDirectories !== false) {
    throw new MonoAcpDiscoveryError(
      "incompatible_discovery",
      "mono-agent ACP source requires client capabilities that Worklab does not support",
    );
  }
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.slice(0, 32).map((warning) => cleanText(warning, { max: 1024 })).filter(Boolean)
    : [];
  const bridgeVersion = advertisedVersion(source.bridgeVersion, "bridge version");
  const protocolVersion = advertisedVersion(source.protocolVersion, "protocol version");
  return {
    schema: MONO_ACP_SOURCE_SCHEMA,
    bridgeVersion,
    protocolVersion,
    installedVersion: cleanText(source.installedVersion, { required: true, max: 128 }),
    sourceId: cleanText(source.sourceId, { required: true, max: 1024 }),
    label: cleanText(source.label, { required: true, max: 1024 }),
    health,
    compatible: source.compatible === true
      && bridgeVersion === MONO_ACP_BRIDGE_VERSION
      && protocolVersion === ACP_PROTOCOL_VERSION,
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

function abortError(signal) {
  if (signal?.reason?.code) return signal.reason;
  return new MonoAcpDiscoveryError("cancelled", "mono-agent ACP discovery was cancelled");
}

function runDiscovery(command, {
  timeoutMs,
  maxBuffer,
  execFileImpl,
  env,
  signal,
}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      execFileImpl(command, ["bridge", "acp", "--discover"], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        shell: false,
        env,
        ...(signal ? { signal } : {}),
      }, (err, stdout) => {
        if (err) {
          if (signal?.aborted) {
            finish(reject, abortError(signal));
            return;
          }
          const reason = err.killed || err.code === "ETIMEDOUT" ? "timed out" : "failed";
          finish(reject, new MonoAcpDiscoveryError(
            reason === "timed out" ? "discovery_timeout" : "discovery_failed",
            `mono-agent ACP discovery ${reason}`,
            { cause: err },
          ));
          return;
        }
        finish(resolvePromise, stdout);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function discoverMonoAcpAgents({
  command,
  timeoutMs = 5_000,
  maxBuffer = 1024 * 1024,
  execFileImpl = execFile,
  env = process.env,
  signal,
} = {}) {
  const executable = command || env.WORKLAB_MONO_AGENT_BIN || "mono-agent";
  const stdout = await runDiscovery(executable, {
    timeoutMs,
    maxBuffer,
    execFileImpl,
    env: monoAcpHostEnvironment(env),
    signal,
  });
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
