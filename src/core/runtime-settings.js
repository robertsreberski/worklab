import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUNTIME_SETTING_FIELDS = {
  host: { env: "WORKLAB_HOST", label: "Host" },
  port: { env: "WORKLAB_PORT", label: "Port" },
  workspace: { env: "WORKLAB_WORKSPACE", label: "Workspace" },
  logLevel: { env: "WORKLAB_LOG_LEVEL", label: "Log level" },
  timezone: { env: "WORKLAB_TIMEZONE", label: "Timezone" },
  runIdleWarningMs: { env: "WORKLAB_RUN_IDLE_WARNING_MS", label: "Idle warning" },
  logInlineLimit: { env: "WORKLAB_LOG_INLINE_LIMIT", label: "Inline log limit" },
  slackBotToken: { env: "WORKLAB_SLACK_BOT_TOKEN", label: "Slack bot token", secret: true },
  slackAppToken: { env: "WORKLAB_SLACK_APP_TOKEN", label: "Slack app token", secret: true },
};

const FIELD_BY_ENV = Object.fromEntries(
  Object.entries(RUNTIME_SETTING_FIELDS).map(([field, spec]) => [spec.env, field]),
);
const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (line.includes("#") && !trimmed.includes('"') && !trimmed.includes("'")) {
    value = value.replace(/\s+#.*$/, "");
  }
  return [key, value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")];
}

function readEnvEntries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).map((line) => ({
    line,
    parsed: parseEnvLine(line),
  }));
}

function quoteEnvValue(value) {
  const text = String(value ?? "");
  if (text && /^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function integerInRange(field, value, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function validateRuntimeSetting(field, value) {
  switch (field) {
    case "host": {
      const text = String(value || "").trim();
      if (!text) throw new Error("host is required");
      return text;
    }
    case "port":
      return integerInRange(field, value, { min: 1, max: 65535 });
    case "workspace": {
      const text = String(value || "").trim();
      if (!text) throw new Error("workspace is required");
      return text;
    }
    case "logLevel": {
      const text = String(value || "").trim().toLowerCase();
      if (!LOG_LEVELS.has(text)) throw new Error(`logLevel must be one of: ${[...LOG_LEVELS].join(", ")}`);
      return text;
    }
    case "timezone": {
      const text = String(value || "").trim();
      if (!text) return "";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: text }).format(new Date());
      } catch {
        throw new Error(`timezone is not a valid IANA timezone: ${text}`);
      }
      return text;
    }
    case "runIdleWarningMs":
      return integerInRange(field, value, { min: 0, max: Number.MAX_SAFE_INTEGER });
    case "logInlineLimit":
      return integerInRange(field, value, { min: 0, max: Number.MAX_SAFE_INTEGER });
    case "slackBotToken":
    case "slackAppToken":
      return String(value || "").trim();
    default:
      throw new Error(`unknown runtime setting: ${field}`);
  }
}

export function validateRuntimeSettingsPatch(patch = {}) {
  const unknown = Object.keys(patch).filter((key) => !(key in RUNTIME_SETTING_FIELDS));
  if (unknown.length) throw new Error(`unknown runtime setting keys: ${unknown.join(",")}`);
  const out = {};
  for (const [field, value] of Object.entries(patch)) out[field] = validateRuntimeSetting(field, value);
  return out;
}

export function runtimeEnvFromValues(values = {}) {
  const env = {};
  for (const [field, spec] of Object.entries(RUNTIME_SETTING_FIELDS)) {
    if (values[field] !== undefined && values[field] !== null) env[spec.env] = String(values[field]);
  }
  return env;
}

export function readRuntimeEnvFile(dataDir) {
  const path = join(dataDir, ".env");
  const values = {};
  const errors = {};
  for (const entry of readEnvEntries(path)) {
    if (!entry.parsed) continue;
    const [envKey, rawValue] = entry.parsed;
    const field = FIELD_BY_ENV[envKey];
    if (!field) continue;
    try {
      values[field] = validateRuntimeSetting(field, rawValue);
    } catch (err) {
      errors[field] = err.message;
    }
  }
  return { path, values, errors };
}

function pickEffective(config = {}) {
  return {
    host: config.host,
    port: config.port,
    workspace: config.workspace,
    logLevel: config.logLevel,
    timezone: config.timezone || "",
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
    slackBotToken: config.slackBotToken || "",
    slackAppToken: config.slackAppToken || "",
  };
}

const SECRET_FIELDS = Object.entries(RUNTIME_SETTING_FIELDS)
  .filter(([, spec]) => spec.secret)
  .map(([field]) => field);

function redactSecrets(values = {}) {
  const out = { ...values };
  for (const field of SECRET_FIELDS) out[field] = "";
  return out;
}

function secretState(effective = {}, desired = {}) {
  const out = {};
  for (const field of SECRET_FIELDS) {
    out[field] = {
      effectivePresent: !!effective[field],
      desiredPresent: !!desired[field],
    };
  }
  return out;
}

export function readRuntimeSettings({ dataDir, config, redact = true }) {
  const effective = pickEffective(config);
  const envFile = readRuntimeEnvFile(dataDir);
  const desired = { ...effective, ...envFile.values };
  const restartRequired = Object.keys(RUNTIME_SETTING_FIELDS).some((field) =>
    String(desired[field] ?? "") !== String(effective[field] ?? "")
  );
  return {
    effective: redact ? redactSecrets(effective) : effective,
    desired: redact ? redactSecrets(desired) : desired,
    editable: RUNTIME_SETTING_FIELDS,
    readOnly: {
      dataDir: config?.dataDir || dataDir,
      repoRoot: config?.repoRoot || "",
    },
    envPath: envFile.path,
    envErrors: envFile.errors,
    secrets: secretState(effective, desired),
    restartRequired,
  };
}

export function writeRuntimeSettings({ dataDir, config, patch }) {
  const validated = validateRuntimeSettingsPatch(patch);
  const path = join(dataDir, ".env");
  const existing = readEnvEntries(path);
  const envPatch = runtimeEnvFromValues(validated);
  const remaining = new Set(Object.keys(envPatch));
  const lines = existing.map((entry) => {
    if (!entry.parsed) return entry.line;
    const [key] = entry.parsed;
    if (!(key in envPatch)) return entry.line;
    remaining.delete(key);
    return `${key}=${quoteEnvValue(envPatch[key])}`;
  });

  if (remaining.size) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    for (const key of remaining) lines.push(`${key}=${quoteEnvValue(envPatch[key])}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
  return readRuntimeSettings({ dataDir, config });
}
