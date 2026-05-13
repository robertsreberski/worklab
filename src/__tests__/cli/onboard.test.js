import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboard } from "../../cli/onboard.js";
import { openDb } from "../../core/db/open.js";
import { readSettings } from "../../core/settings.js";
import { listModels, listProviders } from "../../core/providers.js";

function makeExecutable(dir, name) {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("worklab onboard", () => {
  const dirs = [];
  const originalEnv = { ...process.env };

  function tmp(prefix = "worklab-onboard-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("dry-runs the recommended setup without writing providers, settings, or skills", async () => {
    const root = tmp();
    const bin = join(root, "bin");
    const dataDir = join(root, "data");
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    mkdirSync(bin, { recursive: true });
    makeExecutable(bin, "codex");
    makeExecutable(bin, "claude");
    const lines = [];

    const result = await onboard([
      "--data-dir", dataDir,
      "--workspace", join(root, "workspace"),
      "--dry-run",
      "--yes",
      "--no-start",
    ], {
      env: {
        ...originalEnv,
        PATH: bin,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
      },
      stdout: (line) => lines.push(line),
      fetchImpl: async (url) => {
        if (String(url).includes("/api/tags")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
        if (String(url).includes("/api/embed")) return new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 });
        return new Response("{}", { status: 200 });
      },
      execFileSyncImpl: vi.fn(),
      doctorImpl: vi.fn(),
    });

    expect(result.localProvider.choice).toBe("ollama");
    expect(result.embedding.model).toBe("ollama:nomic-embed-text");
    expect(result.skills.map((entry) => entry.target)).toEqual(["codex", "claude"]);
    expect(result.skills.every((entry) => entry.wrote === false)).toBe(true);
    expect(lines.join("\n")).toContain("[dry-run]");

    const db = openDb(join(dataDir, "worklab.db"));
    expect(listProviders({ db, dataDir })).toEqual([]);
    expect(readSettings(db).default_embedding_model).toBe("");
    db.close();
  });

  it("configures Ollama provider, embedding setting, model discovery, skills, and indexing in a temp data dir", async () => {
    const root = tmp();
    const bin = join(root, "bin");
    const dataDir = join(root, "data");
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    mkdirSync(bin, { recursive: true });
    makeExecutable(bin, "codex");
    makeExecutable(bin, "claude");
    makeExecutable(bin, "ollama");

    const execFileSyncImpl = vi.fn();
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }, { name: "qwen2.5-coder:7b" }],
        }), { status: 200 });
      }
      if (href.endsWith("/api/show")) {
        const { model } = JSON.parse(options.body || "{}");
        return new Response(JSON.stringify(model === "nomic-embed-text"
          ? { model, details: { family: "nomic-bert" }, capabilities: ["embedding"] }
          : { model, details: { family: "qwen" }, capabilities: ["completion", "tools"] }), { status: 200 });
      }
      if (href.endsWith("/api/embed")) {
        return new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    await onboard([
      "--data-dir", dataDir,
      "--workspace", join(root, "workspace"),
      "--yes",
      "--local-provider", "ollama",
      "--embedding", "yes",
      "--no-start",
    ], {
      env: {
        ...originalEnv,
        PATH: bin,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
      },
      stdout: () => {},
      fetchImpl,
      execFileSyncImpl,
      doctorImpl: vi.fn(),
    });

    const db = openDb(join(dataDir, "worklab.db"));
    const providers = listProviders({ db, dataDir });
    expect(providers).toEqual([
      expect.objectContaining({
        name: "Ollama (local)",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
        enabled: true,
      }),
    ]);
    expect(readSettings(db).default_embedding_model).toBe("ollama:nomic-embed-text");
    expect(listModels({ db, providerId: providers[0].id }).map((model) => model.model_name))
      .toEqual(["nomic-embed-text", "qwen2.5-coder:7b"]);
    db.close();

    expect(execFileSyncImpl).toHaveBeenCalledWith("ollama", ["pull", "nomic-embed-text"], expect.any(Object));
    expect(lstatSync(join(codexHome, "skills", "worklab")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(claudeHome, "skills", "worklab")).isSymbolicLink()).toBe(true);
  });

  it("configures OpenAI embeddings when requested and an API key is available", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    process.env.OPENAI_API_KEY = "sk-test";

    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/embeddings")) {
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await onboard([
      "--data-dir", dataDir,
      "--workspace", join(root, "workspace"),
      "--local-provider", "none",
      "--embedding", "openai",
      "--no-start",
    ], {
      env: {
        ...originalEnv,
        OPENAI_API_KEY: "sk-test",
        PATH: "",
      },
      stdout: () => {},
      fetchImpl,
      execFileSyncImpl: vi.fn(),
      doctorImpl: vi.fn(),
    });

    const db = openDb(join(dataDir, "worklab.db"));
    expect(readSettings(db).default_embedding_model).toBe("openai:text-embedding-3-small");
    db.close();
    expect(result.embedding.model).toBe("openai:text-embedding-3-small");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("prints hosted auth and OpenAI key next steps without failing onboarding", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const lines = [];

    const result = await onboard([
      "--data-dir", dataDir,
      "--workspace", join(root, "workspace"),
      "--local-provider", "none",
      "--embedding", "openai",
      "--no-start",
    ], {
      env: {
        ...originalEnv,
        OPENAI_API_KEY: "",
        CODEX_API_KEY: "",
        OPENAI_CODEX_API_KEY: "",
        PATH: "",
      },
      stdout: (line) => lines.push(line),
      fetchImpl: vi.fn(),
      execFileSyncImpl: vi.fn(),
      doctorImpl: vi.fn(),
    });

    const output = lines.join("\n");
    expect(result.embedding.configured).toBe(false);
    expect(output).toContain("Hosted auth");
    expect(output).toContain("worklab auth pi openai-codex");
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).toContain("https://platform.openai.com/api-keys");

    const db = openDb(join(dataDir, "worklab.db"));
    expect(readSettings(db).default_embedding_model).toBe("");
    db.close();
  });
});
