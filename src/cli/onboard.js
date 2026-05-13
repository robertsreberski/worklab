import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { platform as hostPlatform } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import {
  createProvider,
  discoverModels,
  getIndexStatus,
  indexAllSources,
  listModels,
  listProviders,
  loadConfig,
  openDb,
  readSettings,
  runMigrations,
  testEmbeddingBackend,
  testProvider,
  updateProvider,
  worklabBaseUrl,
  writeSettings,
} from "../core/index.js";
import { applyConfigArgs, argValue, hasFlag } from "./args.js";
import { doctor } from "./doctor.js";
import { installSkill } from "./install-skill.js";
import { start } from "./start.js";

const DEFAULT_LOCAL_PROVIDER = "ollama";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const OLLAMA_BASE_URL = "http://localhost:11434";
const LMSTUDIO_BASE_URL = "http://localhost:1234";
const LOCAL_PROVIDER_CHOICES = new Set(["ask", "ollama", "lmstudio", "none"]);
const EMBEDDING_CHOICES = new Set(["ask", "yes", "no"]);
const CONFIG_VALUE_FLAGS = new Set(["--port", "--host", "--data-dir", "--workspace", "--drain-timeout-ms"]);

const PROVIDER_PRESETS = {
  ollama: {
    label: "Ollama",
    command: "ollama",
    name: "Ollama (local)",
    provider_type: "ollama",
    base_url: OLLAMA_BASE_URL,
  },
  lmstudio: {
    label: "LM Studio",
    command: "lms",
    name: "LM Studio",
    provider_type: "lmstudio",
    base_url: LMSTUDIO_BASE_URL,
  },
};

function out(stdout, line = "") {
  if (typeof stdout === "function") stdout(line);
  else console.log(line);
}

function normalizeChoice(value, allowed, fallback, flag) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return normalized;
}

function commandPath(command, pathValue = process.env.PATH || "") {
  for (const dir of String(pathValue || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue scanning PATH.
    }
  }
  return null;
}

function shellEnv(env) {
  return { ...process.env, ...(env || {}) };
}

function createPrompts({ assumeYes = false, input = process.stdin, output = process.stdout } = {}) {
  let rl = null;
  const interactive = !!input?.isTTY && !!output?.isTTY;
  const interfaceForPrompt = () => {
    if (!rl) rl = createInterface({ input, output });
    return rl;
  };
  return {
    async confirm(question, defaultValue = false) {
      if (assumeYes) return true;
      if (!interactive) return defaultValue;
      const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
      const answer = (await interfaceForPrompt().question(`${question}${suffix}`)).trim().toLowerCase();
      if (!answer) return defaultValue;
      return ["y", "yes"].includes(answer);
    },
    async choice(question, choices, defaultValue) {
      if (assumeYes) return defaultValue;
      if (!interactive) return defaultValue;
      const answer = (await interfaceForPrompt().question(`${question} (${choices.join("/")}) [${defaultValue}] `)).trim().toLowerCase();
      return choices.includes(answer) ? answer : defaultValue;
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}

function configArgs(args = []) {
  const outArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    if (eq > 0 && CONFIG_VALUE_FLAGS.has(arg.slice(0, eq))) {
      outArgs.push(arg);
      continue;
    }
    if (CONFIG_VALUE_FLAGS.has(arg)) {
      outArgs.push(arg);
      if (args[i + 1] && !String(args[i + 1]).startsWith("--")) {
        outArgs.push(args[i + 1]);
        i += 1;
      }
    }
  }
  return outArgs;
}

function providerRoot(url) {
  return String(url || "").replace(/\/+$/, "");
}

function findLocalProvider(db, preset, dataDir) {
  const baseUrl = providerRoot(preset.base_url);
  return listProviders({ db, dataDir }).find((provider) => (
    provider.provider_type === preset.provider_type
    && providerRoot(provider.base_url) === baseUrl
  )) || null;
}

function formatSkillResult(entry) {
  if (entry.error) return `${entry.label || entry.target}: ${entry.error}`;
  if (entry.action === "up_to_date") return `${entry.label} skill already up to date`;
  const prefix = entry.wrote ? "" : "[dry-run] ";
  return `${prefix}${entry.label} skill ${entry.action}`;
}

async function installAvailableSkills({ tools, dryRun, env, stdout, prompts }) {
  const results = [];
  for (const target of ["codex", "claude"]) {
    const label = target === "claude" ? "Claude Code" : "Codex";
    if (!tools[target]?.available) {
      results.push({
        target,
        label,
        action: "skipped",
        wrote: false,
        error: `${target === "claude" ? "claude" : "codex"} command not found on PATH`,
      });
      continue;
    }
    try {
      const [entry] = installSkill({ target, dryRun, env });
      results.push(entry);
    } catch (err) {
      if (!dryRun && await prompts.confirm(`Replace existing ${label} Worklab skill with a symlink to this checkout?`, false)) {
        const [entry] = installSkill({ target, dryRun, force: true, env });
        results.push(entry);
        continue;
      }
      results.push({
        target,
        label,
        action: "skipped",
        wrote: false,
        error: err.message,
      });
    }
  }
  for (const entry of results) out(stdout, ` - ${formatSkillResult(entry)}`);
  return results;
}

async function reachableJson(url, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetchImpl(url, { signal });
    if (!res.ok) return { ok: false, status: res.status };
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: true, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function runCommand(command, args, { dryRun, execFileSyncImpl, env, stdout, stdio = "inherit" } = {}) {
  if (dryRun) {
    out(stdout, `[dry-run] ${[command, ...args].join(" ")}`);
    return;
  }
  execFileSyncImpl(command, args, { stdio, env: shellEnv(env) });
}

async function installLocalRuntime({ choice, dryRun, execFileSyncImpl, env, stdout, prompts, platform = hostPlatform() }) {
  if (choice === "none") return { installed: false, skipped: true };
  const preset = PROVIDER_PRESETS[choice];
  if (commandPath(preset.command, env.PATH)) return { installed: false, skipped: false };
  const shouldInstall = await prompts.confirm(`Install ${preset.label} now?`, false);
  if (!shouldInstall) return { installed: false, skipped: true, reason: `${preset.command} not found` };

  if (choice === "ollama") {
    if (platform === "darwin" && commandPath("brew", env.PATH)) {
      runCommand("brew", ["install", "ollama"], { dryRun, execFileSyncImpl, env, stdout });
      return { installed: !dryRun, skipped: false };
    }
    if (platform === "linux") {
      runCommand("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { dryRun, execFileSyncImpl, env, stdout });
      return { installed: !dryRun, skipped: false };
    }
  }

  if (choice === "lmstudio" && (platform === "darwin" || platform === "linux")) {
    runCommand("sh", ["-c", "curl -fsSL https://lmstudio.ai/install.sh | bash"], { dryRun, execFileSyncImpl, env, stdout });
    return { installed: !dryRun, skipped: false };
  }

  return {
    installed: false,
    skipped: true,
    reason: `${preset.label} auto-install is not supported on ${platform}`,
  };
}

async function startLocalRuntime({ choice, dryRun, execFileSyncImpl, env, stdout, fetchImpl, platform = hostPlatform() }) {
  if (choice === "none") return { started: false, skipped: true };
  const preset = PROVIDER_PRESETS[choice];
  const probe = choice === "ollama"
    ? `${preset.base_url}/api/tags`
    : `${preset.base_url}/v1/models`;
  const reachable = await reachableJson(probe, { fetchImpl });
  if (reachable.ok) return { started: false, reachable: true };

  if (!commandPath(preset.command, env.PATH) && !dryRun) {
    return { started: false, reachable: false, reason: `${preset.command} not found on PATH` };
  }

  if (choice === "ollama") {
    if (platform === "darwin" && commandPath("brew", env.PATH)) {
      runCommand("brew", ["services", "start", "ollama"], { dryRun, execFileSyncImpl, env, stdout });
      return { started: !dryRun, reachable: false };
    }
    return { started: false, reachable: false, reason: "Start Ollama with `ollama serve` or your service manager." };
  }

  runCommand("lms", ["server", "start", "--port", "1234"], { dryRun, execFileSyncImpl, env, stdout });
  return { started: !dryRun, reachable: false };
}

async function upsertLocalProvider({ db, dataDir, choice, dryRun, stdout, fetchImpl }) {
  if (choice === "none") return { choice, skipped: true, provider: null, models: [] };
  const preset = PROVIDER_PRESETS[choice];
  const existing = findLocalProvider(db, preset, dataDir);
  const provider = dryRun
    ? {
      id: existing?.id || `${choice}-dry-run`,
      name: preset.name,
      provider_type: preset.provider_type,
      base_url: preset.base_url,
      enabled: true,
    }
    : existing
      ? updateProvider({
        db,
        dataDir,
        id: existing.id,
        patch: {
          name: existing.name || preset.name,
          provider_type: preset.provider_type,
          base_url: preset.base_url,
          enabled: true,
        },
      })
      : createProvider({
        db,
        dataDir,
        name: preset.name,
        provider_type: preset.provider_type,
        base_url: preset.base_url,
        enabled: true,
      });

  out(stdout, ` - ${dryRun ? "[dry-run] " : ""}${existing ? "Use" : "Create"} provider: ${preset.name}`);

  let test = null;
  let models = [];
  if (!dryRun) {
    test = await testProvider({ db, dataDir, providerId: provider.id, fetchImpl });
    if (test.ok) {
      try {
        models = await discoverModels({ db, dataDir, providerId: provider.id, fetchImpl });
        out(stdout, ` - Discovered ${models.length} ${preset.label} model${models.length === 1 ? "" : "s"}`);
      } catch (err) {
        out(stdout, ` - Model discovery failed: ${err.message}`);
      }
    } else {
      out(stdout, ` - Provider unreachable: ${test.error || `HTTP ${test.status}`}`);
    }
  }

  return { choice, provider, test, models };
}

async function resolveLocalProviderChoice({ args, assumeYes, prompts }) {
  const raw = argValue(args, "--local-provider");
  const configured = normalizeChoice(raw, LOCAL_PROVIDER_CHOICES, "ask", "--local-provider");
  if (configured !== "ask") return configured;
  if (assumeYes) return DEFAULT_LOCAL_PROVIDER;
  return prompts.choice(
    "Choose a local provider",
    ["ollama", "lmstudio", "none"],
    DEFAULT_LOCAL_PROVIDER,
  );
}

function embeddingModelFromLmStudio(db, providerId) {
  const models = listModels({ db, providerId });
  const match = models.find((model) => (
    model.enabled
    && (model.capabilities?.embedding === true || /embed/i.test(model.model_name))
  ));
  return match ? `vercel:${providerId}:${match.model_name}` : "";
}

async function setupEmbedding({ db, dataDir, args, localProvider, dryRun, assumeYes, prompts, execFileSyncImpl, env, stdout, fetchImpl }) {
  let choice = normalizeChoice(argValue(args, "--embedding"), EMBEDDING_CHOICES, "ask", "--embedding");
  if (localProvider.choice === "none") choice = "no";
  if (choice === "ask") {
    choice = (assumeYes || await prompts.confirm("Install and configure the default embedding model?", true))
      ? "yes"
      : "no";
  }
  if (choice === "no") return { configured: false, model: null };

  let modelRef = "";
  if (localProvider.choice === "ollama") {
    runCommand("ollama", ["pull", DEFAULT_OLLAMA_EMBEDDING_MODEL], {
      dryRun,
      execFileSyncImpl,
      env,
      stdout,
    });
    modelRef = `ollama:${DEFAULT_OLLAMA_EMBEDDING_MODEL}`;
  } else if (localProvider.choice === "lmstudio" && localProvider.provider?.id) {
    modelRef = dryRun
      ? `vercel:${localProvider.provider.id}:<embedding-model>`
      : embeddingModelFromLmStudio(db, localProvider.provider.id);
    if (!modelRef) {
      return {
        configured: false,
        model: null,
        reason: "No enabled LM Studio embedding model was discovered.",
      };
    }
  }

  if (!modelRef) return { configured: false, model: null };
  if (!dryRun) {
    writeSettings(db, { default_embedding_model: modelRef });
    const health = await testEmbeddingBackend({ db, dataDir, fetchImpl });
    if (health.ok) {
      const index = await indexAllSources({ db, dataDir, fetchImpl });
      out(stdout, ` - Search index ready: ${index.chunks} chunk${index.chunks === 1 ? "" : "s"}`);
      return { configured: true, model: modelRef, health, index };
    }
    out(stdout, ` - Embedding backend configured but unreachable: ${health.error}`);
    return { configured: true, model: modelRef, health };
  }
  return { configured: true, model: modelRef };
}

async function maybeStartWorklab({ args, dryRun, stdout, startImpl }) {
  if (hasFlag(args, "--no-start")) return { skipped: true };
  if (dryRun) {
    out(stdout, `[dry-run] worklab start ${configArgs(args).join(" ")}`.trim());
    return { skipped: true, dryRun: true };
  }
  return startImpl(configArgs(args));
}

async function maybeRunDoctor({ args, dryRun, stdout, doctorImpl }) {
  if (dryRun) {
    out(stdout, `[dry-run] worklab doctor ${configArgs(args).join(" ")}`.trim());
    return { skipped: true, dryRun: true };
  }
  return doctorImpl(configArgs(args));
}

export async function onboard(args = process.argv.slice(3), deps = {}) {
  const env = deps.env || process.env;
  applyConfigArgs(args, env);
  const config = loadConfig(env);
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workspace, { recursive: true });

  const dryRun = hasFlag(args, "--dry-run");
  const assumeYes = hasFlag(args, "--yes");
  const stdout = deps.stdout || console.log;
  const execFileSyncImpl = deps.execFileSyncImpl || execFileSync;
  const fetchImpl = deps.fetchImpl || fetch;
  const prompts = deps.prompts || createPrompts({
    assumeYes,
    input: deps.input || process.stdin,
    output: deps.output || process.stdout,
  });

  const db = deps.db || openDb(join(config.dataDir, "worklab.db"));
  let shouldCloseDb = !deps.db;
  const result = {
    config,
    tools: {},
    skills: [],
    localProvider: null,
    embedding: null,
    start: null,
    doctor: null,
  };

  try {
    runMigrations(db);
    out(stdout, "worklab onboard");
    out(stdout, ` - data: ${config.dataDir}`);
    out(stdout, ` - workspace: ${config.workspace}`);

    const pathValue = env.PATH || process.env.PATH || "";
    result.tools = {
      codex: { available: !!commandPath("codex", pathValue), path: commandPath("codex", pathValue) },
      claude: { available: !!commandPath("claude", pathValue), path: commandPath("claude", pathValue) },
      ollama: { available: !!commandPath("ollama", pathValue), path: commandPath("ollama", pathValue) },
      lms: { available: !!commandPath("lms", pathValue), path: commandPath("lms", pathValue) },
    };

    out(stdout, "Host tools");
    for (const [name, tool] of Object.entries(result.tools)) {
      out(stdout, ` - ${name}: ${tool.available ? tool.path : "not found"}`);
    }

    out(stdout, "Worklab host skills");
    result.skills = await installAvailableSkills({ tools: result.tools, dryRun, env, stdout, prompts });

    const providerChoice = await resolveLocalProviderChoice({ args, assumeYes, prompts });
    result.localProvider = { choice: providerChoice };
    if (providerChoice !== "none") {
      out(stdout, `Local provider: ${PROVIDER_PRESETS[providerChoice].label}`);
      result.localProvider.install = await installLocalRuntime({
        choice: providerChoice,
        dryRun,
        execFileSyncImpl,
        env,
        stdout,
        prompts,
        platform: deps.platform || hostPlatform(),
      });
      result.localProvider.start = await startLocalRuntime({
        choice: providerChoice,
        dryRun,
        execFileSyncImpl,
        env,
        stdout,
        fetchImpl,
        platform: deps.platform || hostPlatform(),
      });
      result.localProvider = {
        ...result.localProvider,
        ...await upsertLocalProvider({ db, dataDir: config.dataDir, choice: providerChoice, dryRun, stdout, fetchImpl }),
      };
    } else {
      out(stdout, "Local provider: skipped");
    }

    out(stdout, "Embeddings");
    result.embedding = await setupEmbedding({
      db,
      dataDir: config.dataDir,
      args,
      localProvider: result.localProvider,
      dryRun,
      assumeYes,
      prompts,
      execFileSyncImpl,
      env,
      stdout,
      fetchImpl,
    });
    if (result.embedding?.model) {
      out(stdout, ` - Default embedding model: ${result.embedding.model}`);
    } else if (result.embedding?.reason) {
      out(stdout, ` - Embeddings not configured: ${result.embedding.reason}`);
    } else {
      out(stdout, " - Embeddings not configured");
    }

    result.indexStatus = getIndexStatus(db, { dataDir: config.dataDir });
    result.settings = readSettings(db);

    out(stdout, "Runtime");
    result.start = await maybeStartWorklab({
      args,
      dryRun,
      stdout,
      startImpl: deps.startImpl || start,
    });
    out(stdout, ` - URL: ${worklabBaseUrl(config)}`);

    out(stdout, "Doctor");
    result.doctor = await maybeRunDoctor({
      args,
      dryRun,
      stdout,
      doctorImpl: deps.doctorImpl || doctor,
    });

    return result;
  } finally {
    prompts.close?.();
    if (shouldCloseDb) {
      db.close();
      shouldCloseDb = false;
    }
  }
}

export const _private = {
  commandPath,
  configArgs,
  createPrompts,
  providerRoot,
};
