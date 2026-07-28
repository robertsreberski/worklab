import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import { loginPiOAuth as runtimeLoginPiOAuth } from "@mono-agent/agent-runtime/ai";
import { loadConfig, readPiAuthFile } from "../core/index.js";
import { applyConfigArgs, hasFlag } from "./args.js";

const CONFIG_VALUE_FLAGS = new Set(["--port", "--host", "--data-dir", "--workspace", "--drain-timeout-ms"]);

function out(stdout, line = "") {
  if (typeof stdout === "function") stdout(line);
  else console.log(line);
}

function authPositionals(args = []) {
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    if (eq > 0 && CONFIG_VALUE_FLAGS.has(arg.slice(0, eq))) continue;
    if (CONFIG_VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--dry-run") continue;
    if (arg.startsWith("--")) throw new Error(`unknown auth option: ${arg}`);
    positionals.push(arg);
  }
  return positionals;
}

export function parseAuthArgs(args = []) {
  const positionals = authPositionals(args);
  if (positionals.length !== 2 || positionals[0] !== "pi" || positionals[1] !== "openai-codex") {
    throw new Error("usage: worklab auth pi openai-codex [options]");
  }
  return {
    provider: "pi",
    providerId: "openai-codex",
    dryRun: hasFlag(args, "--dry-run"),
  };
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// The runtime façade rejects an incomplete callback contract before it starts
// provider login: onAuth, onDeviceCode, onPrompt, and onSelect must all be
// functions. onProgress is optional but Worklab supplies it.
function loginCallbacks({ rl, stdout }) {
  return {
    onAuth: (info) => {
      out(stdout, "");
      out(stdout, `Open this URL in your browser: ${info.url}`);
      if (info.instructions) out(stdout, info.instructions);
    },
    onDeviceCode: (info) => {
      out(stdout, "");
      out(stdout, `Enter this code at ${info.verificationUri}: ${info.userCode}`);
      if (info.expiresInSeconds) {
        out(stdout, `The code expires in ${Math.round(info.expiresInSeconds / 60)} minute(s).`);
      }
    },
    onPrompt: async (request) => {
      const suffix = request.placeholder ? ` (${request.placeholder})` : "";
      return prompt(rl, `${request.message}${suffix}: `);
    },
    onSelect: async (request) => {
      const options = Array.isArray(request.options) ? request.options : [];
      out(stdout, "");
      out(stdout, request.message);
      options.forEach((option, index) => out(stdout, `  ${index + 1}) ${option.label}`));
      const answer = (await prompt(rl, `Choose 1-${options.length}: `)).trim();
      const index = Number(answer);
      // The façade's contract allows an undefined choice; the provider decides
      // whether that aborts the flow or falls back to a default.
      if (!Number.isInteger(index) || index < 1 || index > options.length) return undefined;
      return options[index - 1].id;
    },
    onProgress: (message) => out(stdout, message),
  };
}

export async function loginPiOAuth({
  providerId = "openai-codex",
  dataDir,
  dryRun = false,
  stdout = console.log,
  input = process.stdin,
  output = process.stdout,
  loginPiOAuthImpl = runtimeLoginPiOAuth,
} = {}) {
  if (providerId !== "openai-codex") throw new Error(`unsupported Pi OAuth provider: ${providerId}`);
  const authPath = join(dataDir, "pi-auth.json");
  if (dryRun) {
    out(stdout, `[dry-run] would authenticate Pi OAuth provider ${providerId}`);
    out(stdout, `[dry-run] would write ${authPath}`);
    return { provider: providerId, path: authPath, dryRun: true, wrote: false };
  }

  const rl = createInterface({ input, output });
  try {
    const credentials = await loginPiOAuthImpl(providerId, loginCallbacks({ rl, stdout }));
    const existing = readPiAuthFile(dataDir).credentials || {};
    const next = { ...existing, [providerId]: { type: "oauth", ...credentials } };
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    out(stdout, `pi auth: saved ${providerId} credentials to ${authPath}`);
    return { provider: providerId, path: authPath, wrote: true };
  } finally {
    rl.close();
  }
}

export async function authCli(args = process.argv.slice(3), deps = {}) {
  const env = deps.env || process.env;
  applyConfigArgs(args, env);
  const parsed = parseAuthArgs(args);
  const config = loadConfig(env);
  mkdirSync(config.dataDir, { recursive: true });
  return loginPiOAuth({
    providerId: parsed.providerId,
    dataDir: config.dataDir,
    dryRun: parsed.dryRun,
    stdout: deps.stdout || console.log,
    input: deps.input || process.stdin,
    output: deps.output || process.stdout,
    loginPiOAuthImpl: deps.loginPiOAuthImpl || runtimeLoginPiOAuth,
  });
}
