const OWNER_VALUES = new Set(["client", "agent"]);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  return text(value).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function owner(value, fallback = "client") {
  const raw = text(value).toLowerCase();
  const normalized = raw === "worklab" ? "client" : raw;
  return OWNER_VALUES.has(normalized) ? normalized : fallback;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonObjectText(value) {
  return JSON.stringify(plainObject(value), null, 2);
}

function parseJsonObject(value, label) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = text(value) || "{}";
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function externalAgentKind(agent) {
  if (agent?.kind === "external") return "external";
  if (agent?.kind === "local") return "local";
  const sdk = text(agent?.sdk).toLowerCase();
  const execution = text(firstDefined(agent?.execution_mode, agent?.executionMode, agent?.execution_type, agent?.executionType)).toLowerCase();
  return sdk === "acp" || execution === "acp" ? "external" : "local";
}

export function normalizeAcpProfile(profile = {}) {
  const nestedAgent = profile.agent && typeof profile.agent === "object" ? profile.agent : {};
  const permissionsPolicy = plainObject(firstDefined(profile.permissionsPolicy, profile.permissions_policy));
  return {
    id: text(profile.id),
    agentName: text(firstDefined(profile.agentName, profile.agent_name, nestedAgent.name)),
    displayName: text(firstDefined(profile.displayName, profile.display_name, nestedAgent.display_name, nestedAgent.displayName)),
    description: text(firstDefined(profile.description, nestedAgent.description)),
    enabled: bool(firstDefined(profile.enabled, nestedAgent.enabled), true),
    driver: text(profile.driver) || "generic",
    command: text(profile.command),
    args: stringList(profile.args),
    cwd: text(profile.cwd),
    envKeys: stringList(firstDefined(profile.envKeys, profile.env_keys)),
    monoSourceId: text(firstDefined(profile.monoSourceId, profile.mono_source_id, profile.sourceId, profile.source_id)),
    configurationOwner: owner(firstDefined(profile.configurationOwner, profile.configuration_owner)),
    workspaceOwner: owner(firstDefined(profile.workspaceOwner, profile.workspace_owner)),
    mcpOwner: owner(firstDefined(profile.mcpOwner, profile.mcp_owner)),
    canonicalWorkspace: text(firstDefined(profile.canonicalWorkspace, profile.canonical_workspace)),
    probeTimeoutMs: finiteNumber(firstDefined(profile.probeTimeoutMs, profile.probe_timeout_ms), 30_000),
    permissionsPolicy: {
      filesystem: bool(permissionsPolicy.filesystem),
      terminal: bool(permissionsPolicy.terminal),
      network: bool(permissionsPolicy.network),
      mcp: bool(permissionsPolicy.mcp),
    },
    configPolicy: plainObject(firstDefined(profile.configPolicy, profile.config_policy)),
    sessionPolicy: plainObject(firstDefined(profile.sessionPolicy, profile.session_policy)),
  };
}

export function acpProfileForAgent(profiles = [], agentName = "") {
  const target = text(agentName);
  if (!target) return null;
  return (profiles || []).map(normalizeAcpProfile).find((profile) => profile.agentName === target) || null;
}

export function externalAgentDraft({ agent = {}, profile = {} } = {}) {
  const normalized = normalizeAcpProfile({ ...profile, agent: { ...profile?.agent, ...agent } });
  return {
    agentName: normalized.agentName || text(agent?.name),
    displayName: normalized.displayName || text(firstDefined(agent?.display_name, agent?.displayName)),
    description: normalized.description || text(agent?.description),
    enabled: bool(firstDefined(agent?.enabled, normalized.enabled), true),
    driver: normalized.driver,
    command: normalized.command,
    argsText: normalized.args.join("\n"),
    cwd: normalized.cwd,
    envKeysText: normalized.envKeys.join("\n"),
    configurationOwner: normalized.configurationOwner,
    workspaceOwner: normalized.workspaceOwner,
    mcpOwner: normalized.mcpOwner,
    canonicalWorkspace: normalized.canonicalWorkspace,
    probeTimeoutMs: normalized.probeTimeoutMs,
    allowFilesystem: normalized.permissionsPolicy.filesystem,
    allowTerminal: normalized.permissionsPolicy.terminal,
    allowNetwork: normalized.permissionsPolicy.network,
    allowMcp: normalized.permissionsPolicy.mcp,
    configPolicyText: jsonObjectText(normalized.configPolicy),
    sessionPolicyText: jsonObjectText(normalized.sessionPolicy),
  };
}

export function externalAgentPayload(draft = {}) {
  return {
    agentName: text(draft.agentName) || undefined,
    displayName: text(draft.displayName),
    description: text(draft.description),
    enabled: draft.enabled !== false,
    driver: draft.driver === "mono" ? "mono" : "generic",
    command: text(draft.command),
    args: stringList(draft.argsText),
    cwd: text(draft.cwd) || null,
    envKeys: [...new Set(stringList(draft.envKeysText))],
    configurationOwner: owner(draft.configurationOwner),
    workspaceOwner: owner(draft.workspaceOwner),
    mcpOwner: owner(draft.mcpOwner),
    canonicalWorkspace: text(draft.canonicalWorkspace) || null,
    probeTimeoutMs: finiteNumber(draft.probeTimeoutMs, 30_000),
    permissionsPolicy: {
      filesystem: !!draft.allowFilesystem,
      terminal: !!draft.allowTerminal,
      network: !!draft.allowNetwork,
      mcp: !!draft.allowMcp,
    },
    configPolicy: parseJsonObject(draft.configPolicyText, "Configuration policy"),
    sessionPolicy: parseJsonObject(draft.sessionPolicyText, "Session policy"),
  };
}

export function externalAgentVolatileState(profile = {}) {
  return {
    lastProbe: firstDefined(profile.lastProbe, profile.last_probe, null),
    capabilities: firstDefined(profile.capabilities, profile.agentCapabilities, profile.agent_capabilities, null),
    health: firstDefined(profile.health, profile.status, profile.lastProbe?.status, profile.last_probe?.status, null),
  };
}

export function acpEndpointUnsupported(error) {
  return [404, 405, 501].includes(Number(error?.status))
    || ["not_found", "method_not_found", "not_implemented", "unsupported"].includes(String(error?.code || "").toLowerCase());
}

function discoveryItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return firstDefined(value.sources, value.agents, value.entries, value.discovery?.sources, []);
}

function safeCapability(value, key) {
  const capability = value?.capabilities?.[key];
  return typeof capability === "boolean" ? capability : undefined;
}

export function normalizeMonoDiscovery(response = {}) {
  const schema = text(firstDefined(response.schema, response.contract, response.version));
  const sources = discoveryItems(response).map((entry) => {
    const source = entry?.source && typeof entry.source === "object" ? entry.source : entry;
    const sourceId = text(firstDefined(source?.sourceId, source?.source_id, entry?.sourceId, entry?.source_id));
    if (!sourceId) return null;
    return {
      sourceId,
      label: text(firstDefined(source?.label, source?.displayName, source?.display_name, entry?.label)) || sourceId,
      health: text(firstDefined(source?.health, source?.status, entry?.health, entry?.status)) || "unknown",
      ready: bool(firstDefined(source?.ready, entry?.ready), false),
      imported: bool(firstDefined(source?.imported, entry?.imported), false),
      capabilities: {
        sessions: safeCapability(source, "sessions"),
        clientMcp: safeCapability(source, "clientMcp"),
        filesystem: safeCapability(source, "filesystem"),
        terminal: safeCapability(source, "terminal"),
      },
    };
  }).filter(Boolean);
  return { schema, sources };
}

export function acpProbeStatus(profile = {}, operation = null) {
  const probe = firstDefined(operation, profile.lastProbe, profile.last_probe, null);
  const status = text(firstDefined(probe?.status, probe?.state, profile.health)).toLowerCase();
  if (["queued", "pending", "running", "probing"].includes(status)) return "running";
  if (["success", "succeeded", "healthy", "ready", "complete", "completed"].includes(status)) return "complete";
  if (["failed", "error", "unhealthy", "offline"].includes(status)) return "failed";
  return "disabled";
}
