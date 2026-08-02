import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { newAcpProfileId } from "./ids.js";
import { isValidSlug, slugify } from "./slugs.js";
import {
  deleteAgentByName,
  getAgentByName,
  insertAgent,
  updateAgentFields,
} from "./db/queries/agents.js";
import {
  countAcpAgentReferences,
  getAcpProfileByAgentName,
  getAcpProfileById,
  getAcpProfileByMonoSourceId,
  insertAcpProfile,
  listAcpProfiles,
  updateAcpProfile,
} from "./db/queries/acp-profiles.js";
import { countActiveAcpOperationsForProfile } from "./db/queries/acp-operations.js";

export const ACP_DISCOVERY_SCHEMA = "mono-agent.acp-discovery.v1";
export const ACP_SOURCE_SCHEMA = "mono-agent.acp-source.v1";
export const ACP_BRIDGE_VERSION = 1;
export const ACP_PROTOCOL_VERSION = 1;

const OWNER_VALUES = new Set(["client", "agent"]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ARGS = 128;
const MAX_ENV_KEYS = 128;
const MAX_POLICY_BYTES = 32 * 1024;
const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_STRING_CHARS = 4096;
const MAX_OBJECT_DEPTH = 8;
const MAX_OBJECT_KEYS = 256;
const MIN_PROBE_TIMEOUT_MS = 1_000;
const MAX_PROBE_TIMEOUT_MS = 300_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const SECRET_FIELD_RE = /(?:secret|password|passphrase|token|api[_-]?key|credential|authorization|cookie|env(?:ironment)?_?values?)/iu;
const SECRET_ARG_FLAG_RE = /(?:^|-)(?:api-key|apikey|access-key|accesskey|private-key|privatekey|client-secret|clientsecret|token|secret|password|passwd|passphrase|pass-phrase|credentials?|authorization|authentication|auth|bearer|cookies?)(?:$|-)/u;
const GENERIC_SESSION_POLICY_KEYS = new Set([
  "resumeStrategy",
  "resume_strategy",
  "modeId",
  "mode_id",
]);
const RESUME_STRATEGIES = new Set(["auto", "load", "resume"]);

const DEFAULT_PERMISSIONS_POLICY = Object.freeze({
  filesystem: false,
  terminal: false,
  network: false,
  mcp: false,
});
const UNSUPPORTED_CLIENT_CAPABILITIES = Object.freeze(["filesystem", "terminal", "network", "mcp"]);
const MONO_DESCRIPTOR_OWNED_INPUT_KEYS = Object.freeze([
  "command",
  "args",
  "cwd",
  "envKeys",
  "env_keys",
  "monoSource",
  "mono_source",
  "configurationOwner",
  "configuration_owner",
  "workspaceOwner",
  "workspace_owner",
  "mcpOwner",
  "mcp_owner",
  "canonicalWorkspace",
  "canonical_workspace",
  "permissionsPolicy",
  "permissions_policy",
  "configPolicy",
  "config_policy",
  "sessionPolicy",
  "session_policy",
  "probeTimeoutMs",
  "probe_timeout_ms",
]);

function acpError(message, { code = "validation", status = 400, details } = {}) {
  return Object.assign(new Error(message), {
    code,
    status,
    safeMessage: message,
    ...(details ? { details } : {}),
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inputValue(input, camel, snake = camel, fallback = undefined) {
  if (Object.hasOwn(input || {}, camel)) return input[camel];
  if (snake !== camel && Object.hasOwn(input || {}, snake)) return input[snake];
  return fallback;
}

function boundedString(value, name, { required = false, max = MAX_STRING_CHARS } = {}) {
  if (value == null || value === "") {
    if (required) throw acpError(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") throw acpError(`${name} must be a string`);
  const result = value.trim();
  if (!result && required) throw acpError(`${name} is required`);
  if (result.length > max) throw acpError(`${name} is too long`);
  if (/\0/u.test(result)) throw acpError(`${name} contains a null byte`);
  return result || null;
}

function ensureNoSecretBearingFields(value, path = "profile", depth = 0) {
  if (depth > MAX_OBJECT_DEPTH) throw acpError(`${path} exceeds the maximum nesting depth`);
  if (Array.isArray(value)) {
    if (value.length > MAX_OBJECT_KEYS) throw acpError(`${path} has too many entries`);
    value.forEach((entry, index) => ensureNoSecretBearingFields(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw acpError(`${path} has too many fields`);
  for (const [key, entry] of entries) {
    if (SECRET_FIELD_RE.test(key)) {
      throw acpError(`${path}.${key} may contain secret material and cannot be persisted`);
    }
    ensureNoSecretBearingFields(entry, `${path}.${key}`, depth + 1);
  }
}

function normalizeJsonObject(value, name, fallback = {}) {
  const source = value === undefined ? fallback : value;
  if (!isPlainObject(source)) throw acpError(`${name} must be an object`);
  ensureNoSecretBearingFields(source, name);
  let json;
  try {
    json = JSON.stringify(source);
  } catch {
    throw acpError(`${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(json, "utf8") > MAX_POLICY_BYTES) {
    throw acpError(`${name} exceeds ${MAX_POLICY_BYTES} bytes`);
  }
  return JSON.parse(json);
}

function parseStoredJson(value, fallback) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function normalizePermissionsPolicy(value, fallback = DEFAULT_PERMISSIONS_POLICY) {
  const source = normalizeJsonObject(value, "permissionsPolicy", fallback);
  const unknown = Object.keys(source).filter((key) => !Object.hasOwn(DEFAULT_PERMISSIONS_POLICY, key));
  if (unknown.length) throw acpError(`permissionsPolicy has unsupported fields: ${unknown.join(", ")}`);
  const policy = {};
  for (const key of Object.keys(DEFAULT_PERMISSIONS_POLICY)) {
    const next = source[key] ?? fallback[key] ?? false;
    if (typeof next !== "boolean") throw acpError(`permissionsPolicy.${key} must be a boolean`);
    policy[key] = next;
  }
  return policy;
}

function assertSupportedPermissionsPolicy(policy) {
  const unsupported = UNSUPPORTED_CLIENT_CAPABILITIES.filter((capability) => policy[capability]);
  if (unsupported.length) {
    throw acpError(
      `Worklab does not support ACP client ${unsupported.join(", ")} capabilities`,
      { code: "capability_unsupported" },
    );
  }
  return policy;
}

function assertNoMonoDescriptorOverrides(input) {
  for (const key of MONO_DESCRIPTOR_OWNED_INPUT_KEYS) {
    if (Object.hasOwn(input || {}, key)) {
      throw acpError(`${key} is fixed by the mono source descriptor`);
    }
  }
}

function normalizeOwner(value, name, fallback = "client") {
  const owner = value == null || value === "" ? fallback : String(value).trim();
  if (!OWNER_VALUES.has(owner)) throw acpError(`${name} must be client or agent`);
  return owner;
}

function normalizeProbeTimeout(value, fallback = DEFAULT_PROBE_TIMEOUT_MS) {
  const timeout = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(timeout) || timeout < MIN_PROBE_TIMEOUT_MS || timeout > MAX_PROBE_TIMEOUT_MS) {
    throw acpError(
      `probeTimeoutMs must be an integer from ${MIN_PROBE_TIMEOUT_MS} to ${MAX_PROBE_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

function normalizeStringArray(value, name, { maxItems, validate } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw acpError(`${name} must be an array`);
  if (value.length > maxItems) throw acpError(`${name} has too many entries`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw acpError(`${name}[${index}] must be a string`);
    if (entry.length > MAX_STRING_CHARS || /\0/u.test(entry)) throw acpError(`${name}[${index}] is invalid`);
    if (validate && !validate(entry)) throw acpError(`${name}[${index}] is invalid`);
    return entry;
  });
}

function normalizeArgs(value) {
  return normalizeStringArray(value, "args", { maxItems: MAX_ARGS });
}

function assertNoSecretBearingArgFlags(args) {
  // Generic argv is persisted as non-secret launch configuration. This guard
  // catches obvious credential flags, but cannot prove arbitrary positional
  // text is secret-free. Credential values must be referenced via envKeys.
  args.forEach((argument, index) => {
    const match = argument.match(/^--?([^=]+)/u);
    if (!match) return;
    const flag = match[1]
      .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
      .replace(/[^A-Za-z\d]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase();
    if (SECRET_ARG_FLAG_RE.test(flag)) {
      throw acpError(`args[${index}] uses a secret-bearing flag; persist envKeys names only`);
    }
  });
  return args;
}

function normalizeGenericSessionPolicy(value, fallback = {}) {
  const source = value === undefined ? fallback : value;
  if (!isPlainObject(source)) throw acpError("sessionPolicy must be an object");
  const unknown = Object.keys(source).filter((key) => !GENERIC_SESSION_POLICY_KEYS.has(key));
  if (unknown.length) {
    throw acpError(`sessionPolicy has unsupported fields: ${unknown.join(", ")}`);
  }
  if (Object.hasOwn(source, "resumeStrategy") && Object.hasOwn(source, "resume_strategy")) {
    throw acpError("sessionPolicy must not duplicate resumeStrategy");
  }
  if (Object.hasOwn(source, "modeId") && Object.hasOwn(source, "mode_id")) {
    throw acpError("sessionPolicy must not duplicate modeId");
  }
  const resumeStrategy = inputValue(source, "resumeStrategy", "resume_strategy");
  const modeId = inputValue(source, "modeId", "mode_id");
  const policy = {};
  if (resumeStrategy !== undefined) {
    if (typeof resumeStrategy !== "string" || !RESUME_STRATEGIES.has(resumeStrategy)) {
      throw acpError("sessionPolicy.resumeStrategy must be auto, load, or resume");
    }
    policy.resumeStrategy = resumeStrategy;
  }
  if (modeId !== undefined) {
    policy.modeId = boundedString(modeId, "sessionPolicy.modeId", { required: true, max: 200 });
  }
  return policy;
}

function normalizeEnvKeys(value) {
  const entries = normalizeStringArray(value, "envKeys", {
    maxItems: MAX_ENV_KEYS,
    validate: (entry) => ENV_KEY_RE.test(entry),
  });
  return [...new Set(entries)].sort();
}

function normalizeExecutable(value, name = "command") {
  const command = boundedString(value, name, { required: true });
  if (!isAbsolute(command)) throw acpError(`${name} must be an absolute path`);
  let canonical;
  try {
    canonical = realpathSync(command);
    if (!statSync(canonical).isFile()) throw new Error("not a file");
    accessSync(canonical, constants.X_OK);
  } catch {
    throw acpError(`${name} must resolve to an executable file`);
  }
  return canonical;
}

function normalizeDirectory(value, name, { required = false, requireExisting = true } = {}) {
  const directory = boundedString(value, name, { required });
  if (!directory) return null;
  if (!isAbsolute(directory)) throw acpError(`${name} must be an absolute path`);
  if (!requireExisting) return directory;
  try {
    const canonical = realpathSync(directory);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw acpError(`${name} must resolve to a directory`);
  }
}

function normalizeAgentIdentity(input, defaults = {}) {
  const agentName = boundedString(
    inputValue(input, "agentName", "agent_name", defaults.agentName),
    "agentName",
    { required: true, max: 100 },
  );
  if (!isValidSlug(agentName)) throw acpError("agentName must be a lowercase slug");
  const displayName = boundedString(
    inputValue(input, "displayName", "display_name", defaults.displayName || agentName),
    "displayName",
    { required: true, max: 200 },
  );
  const description = boundedString(
    inputValue(input, "description", "description", defaults.description),
    "description",
    { max: 2000 },
  );
  const enabledValue = inputValue(input, "enabled", "enabled", defaults.enabled ?? true);
  if (typeof enabledValue !== "boolean") throw acpError("enabled must be a boolean");
  return { agentName, displayName, description, enabled: enabledValue };
}

function normalizeMonoDiscoverySource(value) {
  if (!isPlainObject(value) || value.schema !== ACP_SOURCE_SCHEMA) {
    throw acpError(`mono source must use schema ${ACP_SOURCE_SCHEMA}`);
  }
  const bridgeVersion = Number(value.bridgeVersion);
  const protocolVersion = Number(value.protocolVersion);
  if (!Number.isSafeInteger(bridgeVersion) || bridgeVersion < 0
    || !Number.isSafeInteger(protocolVersion) || protocolVersion < 0) {
    throw acpError("mono source versions are invalid", { code: "invalid_discovery" });
  }
  const sourceId = boundedString(value.sourceId, "mono sourceId", { required: true, max: 200 });
  const label = boundedString(value.label, "mono label", { required: true, max: 200 });
  const installedVersion = boundedString(value.installedVersion, "mono installedVersion", {
    required: true,
    max: 100,
  });
  const health = boundedString(value.health, "mono health", { required: true, max: 50 });
  if (!new Set(["running", "stale", "stopped", "failed"]).has(health)) {
    throw acpError("mono health is invalid");
  }
  if (!isPlainObject(value.workspace) || value.workspace.owner !== "agent") {
    throw acpError("mono source must declare an agent-owned workspace");
  }
  const workspacePath = normalizeDirectory(value.workspace.path, "mono workspace.path", {
    required: true,
    requireExisting: false,
  });
  const ownership = value.ownership;
  if (!isPlainObject(ownership)
    || ownership.configuration !== "agent"
    || ownership.workspace !== "agent"
    || ownership.mcp !== "agent") {
    throw acpError("mono source ownership must remain agent-owned");
  }
  const constraints = value.constraints;
  const validConstraints = isPlainObject(constraints)
    && Array.isArray(constraints.promptContent)
    && constraints.promptContent.length === 2
    && constraints.promptContent[0] === "text"
    && constraints.promptContent[1] === "resource_link"
    && constraints.clientMcp === false
    && constraints.clientFilesystem === false
    && constraints.clientTerminal === false
    && constraints.attachments === false
    && constraints.additionalDirectories === false;
  if (!validConstraints) throw acpError("mono source constraints are incompatible");
  const warnings = normalizeStringArray(value.warnings || [], "mono warnings", {
    maxItems: 50,
  }).map((warning) => warning.slice(0, 500));

  const descriptor = {
    schema: ACP_SOURCE_SCHEMA,
    bridgeVersion,
    protocolVersion,
    installedVersion,
    sourceId,
    label,
    health,
    compatible: value.compatible === true
      && bridgeVersion === ACP_BRIDGE_VERSION
      && protocolVersion === ACP_PROTOCOL_VERSION,
    workspace: { path: workspacePath, owner: "agent" },
    ownership: { configuration: "agent", workspace: "agent", mcp: "agent" },
    constraints: {
      promptContent: ["text", "resource_link"],
      clientMcp: false,
      clientFilesystem: false,
      clientTerminal: false,
      attachments: false,
      additionalDirectories: false,
    },
    warnings,
  };
  if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw acpError("mono source descriptor is too large");
  }
  return descriptor;
}

export function normalizeMonoSourceDescriptor(value) {
  const descriptor = normalizeMonoDiscoverySource(value);
  if (!descriptor.compatible) {
    throw acpError("mono source is not ACP-compatible", { code: "incompatible_source" });
  }
  const workspacePath = normalizeDirectory(descriptor.workspace.path, "mono workspace.path", {
    required: true,
  });
  return {
    ...descriptor,
    workspace: { ...descriptor.workspace, path: workspacePath },
  };
}

export function normalizeMonoDiscovery(value) {
  if (!isPlainObject(value) || value.schema !== ACP_DISCOVERY_SCHEMA) {
    throw acpError(`discovery must use schema ${ACP_DISCOVERY_SCHEMA}`, { code: "invalid_discovery" });
  }
  if (Number(value.bridgeVersion) !== ACP_BRIDGE_VERSION
    || Number(value.protocolVersion) !== ACP_PROTOCOL_VERSION) {
    throw acpError("discovery uses an incompatible ACP bridge version", { code: "incompatible_discovery" });
  }
  if (!Array.isArray(value.sources) || value.sources.length > 200) {
    throw acpError("discovery sources must be a bounded array", { code: "invalid_discovery" });
  }
  return {
    schema: ACP_DISCOVERY_SCHEMA,
    bridgeVersion: ACP_BRIDGE_VERSION,
    protocolVersion: ACP_PROTOCOL_VERSION,
    // A current discovery client can see older running services. Preserve
    // those sanitized rows so the UI can explain that an upgrade/restart is
    // required, while normalizeMonoSourceDescriptor still rejects import.
    sources: value.sources.map(normalizeMonoDiscoverySource),
  };
}

function normalizeGenericProfile(input, current = null) {
  for (const key of ["env", "environment", "credentials", "secrets", "auth", "apiKey", "api_key"]) {
    if (Object.hasOwn(input || {}, key)) {
      throw acpError(`${key} is not accepted; persist envKeys names only`);
    }
  }
  ensureNoSecretBearingFields(input, "profile");
  const identity = normalizeAgentIdentity(input, current?.agent);
  const command = normalizeExecutable(inputValue(input, "command", "command", current?.command));
  const args = assertNoSecretBearingArgFlags(
    normalizeArgs(inputValue(input, "args", "args", current?.args || [])),
  );
  const cwd = normalizeDirectory(inputValue(input, "cwd", "cwd", current?.cwd), "cwd");
  const envKeys = normalizeEnvKeys(inputValue(input, "envKeys", "env_keys", current?.envKeys || []));
  const configurationOwner = normalizeOwner(
    inputValue(input, "configurationOwner", "configuration_owner", current?.configurationOwner),
    "configurationOwner",
  );
  const workspaceOwner = normalizeOwner(
    inputValue(input, "workspaceOwner", "workspace_owner", current?.workspaceOwner),
    "workspaceOwner",
  );
  const mcpOwner = normalizeOwner(
    inputValue(input, "mcpOwner", "mcp_owner", current?.mcpOwner),
    "mcpOwner",
  );
  const canonicalWorkspace = normalizeDirectory(
    inputValue(input, "canonicalWorkspace", "canonical_workspace", current?.canonicalWorkspace),
    "canonicalWorkspace",
    { required: workspaceOwner === "agent" },
  );
  const permissionsPolicy = assertSupportedPermissionsPolicy(normalizePermissionsPolicy(
    inputValue(input, "permissionsPolicy", "permissions_policy", current?.permissionsPolicy),
  ));
  const configPolicyInput = inputValue(input, "configPolicy", "config_policy");
  if (configPolicyInput !== undefined
    && (!isPlainObject(configPolicyInput) || Object.keys(configPolicyInput).length !== 0)) {
    throw acpError("configPolicy is reserved and must be an empty object");
  }
  const configPolicy = {};
  const sessionPolicy = normalizeGenericSessionPolicy(
    inputValue(input, "sessionPolicy", "session_policy", current?.sessionPolicy),
  );
  const probeTimeoutMs = normalizeProbeTimeout(
    inputValue(input, "probeTimeoutMs", "probe_timeout_ms", current?.probeTimeoutMs),
  );
  return {
    ...identity,
    driver: "generic",
    command,
    args,
    cwd,
    envKeys,
    monoSourceId: null,
    monoSource: {},
    configurationOwner,
    workspaceOwner,
    mcpOwner,
    canonicalWorkspace,
    permissionsPolicy,
    configPolicy,
    sessionPolicy,
    probeTimeoutMs,
  };
}

function normalizeMonoProfile(input, mono, current = null) {
  assertNoMonoDescriptorOverrides(input);
  const descriptor = normalizeMonoSourceDescriptor(mono?.descriptor || current?.monoSource);
  const sourceId = boundedString(
    inputValue(input, "sourceId", "source_id", descriptor.sourceId),
    "sourceId",
    { required: true, max: 200 },
  );
  if (sourceId !== descriptor.sourceId) throw acpError("sourceId does not match the discovered mono source");
  const defaultName = isValidSlug(sourceId) ? sourceId : slugify(descriptor.label || sourceId) || "external-agent";
  const identity = normalizeAgentIdentity(input, {
    agentName: current?.agent?.agentName || defaultName,
    displayName: current?.agent?.displayName || descriptor.label,
    description: current?.agent?.description || `Managed by mono-agent source ${sourceId}`,
    enabled: current?.agent?.enabled ?? true,
  });
  const command = normalizeExecutable(mono?.command || current?.command, "mono command");
  const args = normalizeArgs(mono?.args || current?.args || []);
  const envKeys = normalizeEnvKeys(mono?.envKeys || current?.envKeys || []);
  return {
    ...identity,
    driver: "mono",
    command,
    args,
    cwd: descriptor.workspace.path,
    envKeys,
    monoSourceId: sourceId,
    monoSource: descriptor,
    configurationOwner: "agent",
    workspaceOwner: "agent",
    mcpOwner: "agent",
    canonicalWorkspace: descriptor.workspace.path,
    permissionsPolicy: { ...DEFAULT_PERMISSIONS_POLICY },
    configPolicy: { ...descriptor.constraints },
    sessionPolicy: normalizeJsonObject(current?.sessionPolicy, "sessionPolicy"),
    probeTimeoutMs: normalizeProbeTimeout(current?.probeTimeoutMs),
  };
}

export function rowToAcpProfile(row) {
  if (!row) return null;
  const lastProbe = row.last_probe_state ? {
    state: row.last_probe_state,
    at: row.last_probe_at || null,
    result: parseStoredJson(row.last_probe_result_json, {}),
    error: parseStoredJson(row.last_probe_error_json, {}),
  } : null;
  return {
    id: row.id,
    agentName: row.agent_name,
    driver: row.driver,
    command: row.command,
    args: parseStoredJson(row.args_json, []),
    cwd: row.cwd || null,
    envKeys: parseStoredJson(row.env_keys_json, []),
    monoSourceId: row.mono_source_id || null,
    monoSource: parseStoredJson(row.mono_source_json, {}),
    configurationOwner: row.configuration_owner,
    workspaceOwner: row.workspace_owner,
    mcpOwner: row.mcp_owner,
    canonicalWorkspace: row.canonical_workspace || null,
    permissionsPolicy: parseStoredJson(row.permissions_policy_json, DEFAULT_PERMISSIONS_POLICY),
    configPolicy: parseStoredJson(row.config_policy_json, {}),
    sessionPolicy: parseStoredJson(row.session_policy_json, {}),
    probeTimeoutMs: row.probe_timeout_ms,
    lastProbe,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agent: {
      agentName: row.agent_name,
      displayName: row.agent_display_name,
      description: row.agent_description || null,
      enabled: !!row.agent_enabled,
      sdk: row.agent_sdk,
      model: row.agent_model,
      executionMode: row.agent_execution_mode,
    },
  };
}

function persistenceFields(profile, { id, createdAt, updatedAt }) {
  return {
    id,
    agentName: profile.agentName,
    driver: profile.driver,
    command: profile.command,
    argsJson: JSON.stringify(profile.args),
    cwd: profile.cwd,
    envKeysJson: JSON.stringify(profile.envKeys),
    monoSourceId: profile.monoSourceId,
    monoSourceJson: JSON.stringify(profile.monoSource),
    configurationOwner: profile.configurationOwner,
    workspaceOwner: profile.workspaceOwner,
    mcpOwner: profile.mcpOwner,
    canonicalWorkspace: profile.canonicalWorkspace,
    permissionsPolicyJson: JSON.stringify(profile.permissionsPolicy),
    configPolicyJson: JSON.stringify(profile.driver === "generic" ? {} : profile.configPolicy),
    sessionPolicyJson: JSON.stringify(
      profile.driver === "generic" ? normalizeGenericSessionPolicy(profile.sessionPolicy) : profile.sessionPolicy,
    ),
    probeTimeoutMs: profile.probeTimeoutMs,
    createdAt,
    updatedAt,
  };
}

function bindAgent(db, profile, profileId, now) {
  const existing = getAgentByName(db, profile.agentName);
  if (!existing) {
    insertAgent(db, {
      name: profile.agentName,
      displayName: profile.displayName,
      description: profile.description,
      sdk: "acp",
      model: `acp:${profileId}`,
      effort: "medium",
      contextWindow: "default",
      fastMode: false,
      instructions: "",
      skillsAllowlistJson: "[]",
      skillsAllowlistMode: "all",
      mcpAllowlistJson: "[]",
      mcpAllowlistMode: "all",
      builtinAllowlistJson: "[]",
      builtinAllowlistMode: "all",
      allowSelfReview: 1,
      browserToolsReviewOnly: 0,
      subagentMode: "advisory",
      executionMode: "acp",
      enabled: profile.enabled ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  const otherProfile = getAcpProfileByAgentName(db, profile.agentName);
  if (!otherProfile) {
    throw acpError("agent name already exists and cannot be adopted by an ACP profile", {
      code: "conflict",
      status: 409,
    });
  }
  if (otherProfile.id !== profileId) {
    throw acpError("agent is already bound to another ACP profile", { code: "conflict", status: 409 });
  }
  updateAgentFields(db, [
    "display_name = ?",
    "description = ?",
    "sdk = 'acp'",
    "model = ?",
    "execution_mode = 'acp'",
    "fast_mode = 0",
    "enabled = ?",
    "updated_at = ?",
  ], [
    profile.displayName,
    profile.description,
    `acp:${profileId}`,
    profile.enabled ? 1 : 0,
    now,
    profile.agentName,
  ]);
}

export function createAcpProfile({ db, input = {}, mono = null, id = newAcpProfileId(), now = Date.now() }) {
  if (typeof id !== "string" || !UUID_RE.test(id)) throw acpError("ACP profile id must be a UUID");
  const sourceId = inputValue(input, "sourceId", "source_id");
  const requestedDriver = input.driver || (sourceId ? "mono" : "generic");
  if (!new Set(["generic", "mono"]).has(requestedDriver)) {
    throw acpError("driver must be generic or mono");
  }
  if (requestedDriver === "mono" && !mono) {
    throw acpError("mono profiles must be created from discovery", { code: "discovery_required" });
  }
  const profile = requestedDriver === "mono"
    ? normalizeMonoProfile(input, mono)
    : normalizeGenericProfile(input);

  const transaction = db.transaction(() => {
    if (getAcpProfileById(db, id)) throw acpError("ACP profile id already exists", { code: "conflict", status: 409 });
    if (profile.monoSourceId && getAcpProfileByMonoSourceId(db, profile.monoSourceId)) {
      throw acpError("mono source is already imported", { code: "conflict", status: 409 });
    }
    bindAgent(db, profile, id, now);
    insertAcpProfile(db, persistenceFields(profile, { id, createdAt: now, updatedAt: now }));
  });
  transaction();
  return rowToAcpProfile(getAcpProfileById(db, id));
}

export function updateAcpProfileRecord({ db, id, input = {}, now = Date.now() }) {
  const row = getAcpProfileById(db, id);
  if (!row) throw acpError("ACP profile not found", { code: "not_found", status: 404 });
  const current = rowToAcpProfile(row);
  for (const [camel, snake] of [["agentName", "agent_name"], ["driver", "driver"], ["sourceId", "source_id"]]) {
    const value = inputValue(input, camel, snake);
    const expected = camel === "agentName" ? current.agentName
      : camel === "driver" ? current.driver
        : current.monoSourceId;
    if (value !== undefined && value !== expected) throw acpError(`${camel} is immutable`);
  }
  const profile = current.driver === "mono"
    ? normalizeMonoProfile(input, null, current)
    : normalizeGenericProfile(input, current);
  const transaction = db.transaction(() => {
    bindAgent(db, profile, id, now);
    const fields = persistenceFields(profile, { id, createdAt: current.createdAt, updatedAt: now });
    if (updateAcpProfile(db, fields).changes !== 1) {
      throw acpError("ACP profile not found", { code: "not_found", status: 404 });
    }
  });
  transaction();
  return rowToAcpProfile(getAcpProfileById(db, id));
}

export function getAcpProfile({ db, id }) {
  return rowToAcpProfile(getAcpProfileById(db, id));
}

export function getAcpProfileForAgent({ db, agentName }) {
  return rowToAcpProfile(getAcpProfileByAgentName(db, agentName));
}

export function getAcpProfiles({ db }) {
  return listAcpProfiles(db).map(rowToAcpProfile);
}

export function deleteAcpProfileRecord({ db, id }) {
  const row = getAcpProfileById(db, id);
  if (!row) throw acpError("ACP profile not found", { code: "not_found", status: 404 });
  const activeOperations = countActiveAcpOperationsForProfile(db, id);
  if (activeOperations > 0) {
    throw acpError("ACP profile has an active operation", {
      code: "profile_in_use",
      status: 409,
      details: { activeOperations },
    });
  }
  const references = countAcpAgentReferences(db, row.agent_name);
  if (references.total > 0) {
    throw acpError("ACP agent is referenced and cannot be deleted", {
      code: "profile_in_use",
      status: 409,
      details: { references },
    });
  }
  const transaction = db.transaction(() => {
    const latest = getAcpProfileById(db, id);
    if (!latest) throw acpError("ACP profile not found", { code: "not_found", status: 404 });
    if (deleteAgentByName(db, latest.agent_name).changes !== 1) {
      throw acpError("bound ACP agent not found", { code: "binding_invalid", status: 409 });
    }
  });
  transaction();
  return { id, agentName: row.agent_name };
}

export function assertAcpProfileBinding({ db, id }) {
  const row = getAcpProfileById(db, id);
  if (!row) throw acpError("ACP profile not found", { code: "not_found", status: 404 });
  const expectedModel = `acp:${id}`;
  if (row.agent_sdk !== "acp" || row.agent_execution_mode !== "acp" || row.agent_model !== expectedModel) {
    throw acpError("ACP profile binding is inconsistent", {
      code: "binding_invalid",
      status: 409,
      details: {
        expected: { sdk: "acp", executionMode: "acp", model: expectedModel },
      },
    });
  }
  return rowToAcpProfile(row);
}
