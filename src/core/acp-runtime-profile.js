import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { assertAcpProfileBinding } from "./acp-profiles.js";
import { discoverMonoAcpAgents } from "./acp-mono-discovery.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MONO_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL"];
const MAX_ACP_LINE_BYTES = 16 * 1024 * 1024;

function runtimeProfileError(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message });
}

function selectedEnvironment(keys, env) {
  const result = {};
  const missing = [];
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) throw runtimeProfileError("profile_invalid", "ACP profile contains an invalid environment key");
    if (typeof env[key] !== "string") missing.push(key);
    else result[key] = env[key];
  }
  if (missing.length) {
    throw runtimeProfileError(
      "environment_missing",
      `ACP profile requires unavailable environment keys: ${missing.join(", ")}`,
    );
  }
  return result;
}

function sessionConfiguration(profile) {
  const policy = profile.sessionPolicy && typeof profile.sessionPolicy === "object"
    ? profile.sessionPolicy
    : {};
  const resumeStrategy = ["auto", "load", "resume"].includes(policy.resumeStrategy)
    ? policy.resumeStrategy
    : "auto";
  const configOptions = policy.configOptions && typeof policy.configOptions === "object" && !Array.isArray(policy.configOptions)
    ? policy.configOptions
    : {};
  return {
    additionalDirectories: [],
    mcpServers: [],
    resumeStrategy,
    ...(profile.configurationOwner === "client" && typeof policy.modeId === "string"
      ? { modeId: policy.modeId }
      : {}),
    ...(profile.configurationOwner === "client" ? { configOptions } : {}),
  };
}

export function createWorklabAcpProfileResolver({ db, env = process.env } = {}) {
  return async function resolveAcpProfile(profileId) {
    const profile = assertAcpProfileBinding({ db, id: profileId });
    if (!profile.agent.enabled) throw runtimeProfileError("profile_disabled", "ACP profile agent is disabled");
    const unsupported = ["filesystem", "terminal", "mcp"]
      .filter((capability) => profile.permissionsPolicy?.[capability] === true);
    if (unsupported.length) {
      throw runtimeProfileError(
        "capability_unsupported",
        `Worklab does not enable ACP client ${unsupported.join(", ")} capabilities`,
      );
    }
    return {
      command: profile.command,
      args: profile.args,
      cwd: profile.cwd || profile.canonicalWorkspace || undefined,
      env: selectedEnvironment(profile.envKeys, env),
      configurationOwner: profile.configurationOwner,
      workspaceOwner: profile.workspaceOwner,
      mcpOwner: profile.mcpOwner,
      ...(profile.canonicalWorkspace ? { workspacePath: profile.canonicalWorkspace } : {}),
      capabilityPolicy: {
        filesystem: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: true, url: true },
        sessionConfig: { boolean: false },
        mcp: { stdio: false, http: false, sse: false },
      },
      sessionConfig: sessionConfiguration(profile),
      process: {
        startupTimeoutMs: profile.probeTimeoutMs,
        requestTimeoutMs: 0,
        shutdownGraceMs: 1_000,
        killGraceMs: 1_000,
        stderrTailBytes: 8 * 1024,
        maxLineBytes: MAX_ACP_LINE_BYTES,
      },
    };
  };
}

export function resolveExecutable(command, env = process.env) {
  const candidates = isAbsolute(command)
    ? [command]
    : String(env.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      if (!statSync(canonical).isFile()) continue;
      accessSync(canonical, constants.X_OK);
      return canonical;
    } catch { /* try next PATH entry */ }
  }
  throw runtimeProfileError("mono_agent_not_found", "mono-agent executable was not found");
}

export function createMonoAcpDiscoveryControls({
  command = process.env.WORKLAB_MONO_AGENT_BIN || "mono-agent",
  env = process.env,
  discover = discoverMonoAcpAgents,
} = {}) {
  const executable = () => resolveExecutable(command, env);
  async function discoverMono(options = {}) {
    return discover({ command: executable(), env, ...options });
  }
  async function resolveMonoSource({ sourceId, signal } = {}) {
    if (signal?.aborted) throw signal.reason || runtimeProfileError("cancelled", "mono-agent discovery was cancelled");
    const discovery = await discoverMono();
    const descriptor = discovery.sources.find((source) => source.sourceId === sourceId);
    if (!descriptor) throw runtimeProfileError("source_not_found", "mono-agent source was not found");
    if (!descriptor.compatible) throw runtimeProfileError("source_incompatible", "mono-agent source is not compatible");
    return {
      descriptor,
      command: executable(),
      args: ["bridge", "acp", "--source-id", descriptor.sourceId],
      envKeys: MONO_ENV_KEYS.filter((key) => typeof env[key] === "string"),
    };
  }
  return { discoverMono, resolveMonoSource };
}

