import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider, upsertModel } from "../../core/providers.js";
import { makeTestDb } from "../helpers/test-db.js";

const mockRun = vi.fn();
const mockCreateRuntime = vi.fn(() => ({ run: mockRun }));
const mockCreateRouterRuntime = vi.fn(() => ({ run: mockRun }));
const temporaryDirectories = [];
const openDatabases = [];

function applyPolicyOptions(runOptions, policyOptions = {}) {
  const merged = { ...runOptions };
  for (const key of ["allowedTools", "disallowedTools", "permissionMode"]) {
    if (!Object.hasOwn(policyOptions, key)) continue;
    if (policyOptions[key] === undefined) delete merged[key];
    else merged[key] = policyOptions[key];
  }
  return merged;
}

vi.mock("@mono-agent/agent-runtime", () => ({
  createRuntime: mockCreateRuntime,
  createRouterRuntime: mockCreateRouterRuntime,
  createMetricsObserver: () => ({ recordEvent: () => {}, snapshot: () => ({}) }),
}));

const { generateResponse, resolveModel, WORKLAB_BUILTIN_TOOLS } = await import("../../core/ai.js");

afterEach(() => {
  mockRun.mockReset();
  mockCreateRuntime.mockClear();
  mockCreateRouterRuntime.mockClear();
  delete process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS;
  delete process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS;
  delete process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS;
  delete process.env.WORKLAB_PI_CODEX_TRANSPORT;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const db of openDatabases.splice(0)) db.close();
});

describe("generateResponse Codex runtime options", () => {
  it("passes thread/start hardening overrides from the environment", async () => {
    process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS = "90000";
    process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS = "3";
    process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS = "1000";
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockRun).toHaveBeenCalledWith("sys", expect.objectContaining({
      codexThreadStartTimeoutMs: "90000",
      codexThreadStartAttempts: "3",
      codexThreadStartBackoffMs: "1000",
    }));
  });

  it("lets explicit thread/start hardening options win over environment defaults", async () => {
    process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS = "90000";
    process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS = "3";
    process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS = "1000";
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
      codexThreadStartTimeoutMs: 120000,
      codexThreadStartAttempts: 2,
      codexThreadStartBackoffMs: 500,
    });

    expect(mockRun).toHaveBeenCalledWith("sys", expect.objectContaining({
      codexThreadStartTimeoutMs: 120000,
      codexThreadStartAttempts: 2,
      codexThreadStartBackoffMs: 500,
    }));
  });

  it("passes the saved Pi Codex transport setting to the runtime", async () => {
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      settings: { agent_pi_codex_transport: "websocket-cached" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockRun).toHaveBeenCalledWith("sys", expect.objectContaining({
      piCodexTransport: "websocket-cached",
    }));
  });

  it("preserves Worklab runtime brand when creating the mono runtime", async () => {
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockCreateRuntime).toHaveBeenCalledWith(expect.objectContaining({
      runtimeBrand: expect.objectContaining({
        schemaPrefix: "worklab",
        mcpClientName: "worklab",
        tempdirPrefix: "worklab-cli-",
        providerModelPrefix: "worklab",
        doctorCommand: "worklab doctor",
        serviceName: "worklab",
        clientInfoTitle: "Worklab",
      }),
    }));
  });

  it("binds a persistent session-token key only for ACP runtimes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-runtime-key-"));
    temporaryDirectories.push(dataDir);
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("acp:11111111-1111-4111-8111-111111111111"),
      dataDir,
      messages: [{ role: "user", content: "hi" }],
    });
    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      dataDir,
      messages: [{ role: "user", content: "hi" }],
    });

    const acpKey = mockCreateRuntime.mock.calls[0][0].acpSessionTokenKey;
    expect(acpKey).toBeInstanceOf(Uint8Array);
    expect(acpKey).toHaveLength(32);
    expect(mockCreateRuntime.mock.calls[1][0]).not.toHaveProperty("acpSessionTokenKey");
  });

  it("lets explicit and environment Pi Codex transport overrides win over settings", async () => {
    process.env.WORKLAB_PI_CODEX_TRANSPORT = "websocket";
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      settings: { agent_pi_codex_transport: "websocket-cached" },
      messages: [{ role: "user", content: "hi" }],
    });

    await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      settings: { agent_pi_codex_transport: "websocket-cached" },
      piCodexTransport: "sse",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockRun).toHaveBeenNthCalledWith(1, "sys", expect.objectContaining({
      piCodexTransport: "websocket",
    }));
    expect(mockRun).toHaveBeenNthCalledWith(2, "sys", expect.objectContaining({
      piCodexTransport: "sse",
    }));
  });

  it("threads the skills root without opting into new retry or environment surfaces", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    const skillsRoot = resolve("/tmp/worklab-data/skills");
    const skills = [{
      name: "reader",
      trigger: "when repository context is needed",
      enabled: true,
      assetsPath: resolve(skillsRoot, "reader"),
    }];

    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      skills,
      fallbackChain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
    });

    const routerOptions = mockCreateRouterRuntime.mock.calls[0][0];
    expect(routerOptions).not.toHaveProperty("retry");
    expect(routerOptions.chain).toEqual([
      {
        model: { sdk: "pi", provider: "openai", model: "gpt-5.5" },
        executionMode: "sdk",
      },
      {
        model: { sdk: "claude", model: "claude-sonnet-4-6" },
        executionMode: "sdk",
      },
    ]);
    expect(routerOptions.chain.every((entry) => !Object.hasOwn(entry, "attempts"))).toBe(true);

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions).toMatchObject({
      skills,
      skillsRoot,
      skillDirs: [skillsRoot],
    });
    expect(runOptions).not.toHaveProperty("toolEnvironment");
    // Team-roster subagents are gone; the roster now only drives durable
    // delegation into child tasks.
    expect(runOptions).not.toHaveProperty("nativeSubagents");
  });

  it("re-resolves custom Pi metadata for a routed attempt", async () => {
    const db = makeTestDb();
    openDatabases.push(db);
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-custom-pi-route-"));
    temporaryDirectories.push(dataDir);
    const provider = createProvider({
      db,
      dataDir,
      name: "local compat",
      provider_type: "openai_compat",
      base_url: "http://127.0.0.1:4545",
    });
    const model = upsertModel({
      db,
      providerId: provider.id,
      modelName: "local-model",
      capabilities: { chat: true, tools: true, reasoning: true },
      enabled: true,
    });
    const resolutions = [];
    mockCreateRouterRuntime.mockImplementationOnce(({ chain, resolveAttempt }) => ({
      run: async () => {
        for (const [attemptIndex, entry] of chain.entries()) {
          resolutions.push(await resolveAttempt({
            model: entry.model,
            executionMode: entry.executionMode,
            attemptIndex,
            retryIndex: 0,
          }));
        }
        return { text: "ok" };
      },
    }));

    await generateResponse("sys", {
      model: resolveModel(`pi:${provider.id}:${model.model_name}`),
      fallbackChain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
      messages: [{ role: "user", content: "hi" }],
      settings: {},
      db,
      dataDir,
      allowedTools: ["Read"],
      disallowedTools: [],
    });

    expect(resolutions[0].options).toMatchObject({
      customProvider: { id: provider.id },
      customModel: { id: model.id, model_name: "local-model" },
      modelCapabilities: expect.any(Object),
      isPrivateProvider: true,
    });
    expect(resolutions[1].options).toEqual({});
  });

  // The router keeps one provider-option bag across attempts. Adapters ignore
  // irrelevant fields, so every run gets all three discovery knobs rather than
  // selecting them from only the primary SDK.
  it("opts pi into inline Agent helpers bounded by the parent's read-only tools", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      allowedTools: ["Read", "Grep", "Bash", "Agent", "Skill"],
      disallowedTools: ["Grep"],
    });

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions.subagents).toEqual({
      inline: { enabled: true, allowedTools: ["Read"] },
      maxConcurrent: 3,
      maxPerTurn: 10,
    });
    expect(runOptions.settingSources).toEqual(["user", "project", "local"]);
    expect(runOptions.codexLoadProjectDocs).toBe(true);
  });

  it("treats a wildcard parent policy as the full read-only Pi child ceiling", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      allowedTools: ["*"],
      disallowedTools: ["WebSearch"],
    });

    expect(mockRun.mock.calls[0][1].subagents.inline.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
    ]);
  });

  it("suppresses Pi inline helpers when the parent grants no read-only child tools", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      allowedTools: ["Agent", "Bash"],
      disallowedTools: [],
    });

    expect(mockRun.mock.calls[0][1]).not.toHaveProperty("subagents");
  });

  it("treats a wildcard deny as withholding every Pi child tool", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      allowedTools: ["*"],
      disallowedTools: ["*"],
    });

    expect(mockRun.mock.calls[0][1]).not.toHaveProperty("subagents");
  });

  it("lets every route read the provider-native discovery options it owns", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("claude:claude-sonnet-4-6"),
      messages: [{ role: "user", content: "hi" }],
    });

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions.settingSources).toEqual(["user", "project", "local"]);
    expect(runOptions.codexLoadProjectDocs).toBe(true);
    expect(runOptions.subagents.inline.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
    ]);
  });

  it("keeps native options on the run bag when a forced fallback changes SDK", async () => {
    const attempts = [];
    mockCreateRouterRuntime.mockImplementationOnce(({ chain, resolveAttempt }) => ({
      run: async (systemPrompt, runOptions) => {
        for (const [index, entry] of chain.entries()) {
          const resolution = await resolveAttempt({
            model: entry.model,
            executionMode: entry.executionMode,
            attemptIndex: index,
            retryIndex: 0,
          });
          const attemptOptions = applyPolicyOptions({
            ...runOptions,
            model: entry.model,
            executionMode: entry.executionMode,
          }, resolution.policyOptions);
          attempts.push({ systemPrompt, options: attemptOptions });
          if (index < chain.length - 1) continue; // force each route to fall through
          return { text: "fallback ok" };
        }
        return { text: null, failureKind: "provider_unavailable_exhausted" };
      },
    }));

    const result = await generateResponse("sys", {
      model: resolveModel("claude:claude-sonnet-4-6"),
      fallbackChain: [
        { sdk: "pi", provider: "openai", model: "gpt-5.5" },
        { sdk: "codex", model: "gpt-5.5" },
      ],
      messages: [{ role: "user", content: "hi" }],
      allowedTools: ["Read", "Grep", "Agent", "Task", "Skill"],
      disallowedTools: [],
    });

    expect(result.text).toBe("fallback ok");
    expect(attempts).toHaveLength(3);
    expect(attempts[0].options.model.sdk).toBe("claude");
    expect(attempts[0].options.executionMode).toBe("sdk");
    expect(attempts[1].options.model.sdk).toBe("pi");
    expect(attempts[1].options.executionMode).toBe("sdk");
    expect(attempts[2].options.model.sdk).toBe("codex");
    expect(attempts[2].options.executionMode).toBe("cli");
    for (const attempt of attempts) {
      expect(attempt.options.settingSources).toEqual(["user", "project", "local"]);
      expect(attempt.options.codexLoadProjectDocs).toBe(true);
      expect(attempt.options.subagents.inline.allowedTools).toEqual(["Read", "Grep"]);
    }
    // A genuine subset remains a subset on direct Codex so that bridge can
    // fail closed; it is never widened merely to keep fallback moving.
    expect(attempts[2].options.allowedTools).toEqual(["Read", "Grep", "Agent", "Task", "Skill"]);
  });

  it("projects an all-builtins policy per route without widening Claude", async () => {
    const attempts = [];
    mockCreateRouterRuntime.mockImplementationOnce(({ chain, resolveAttempt }) => ({
      run: async (_systemPrompt, runOptions) => {
        for (const [index, entry] of chain.entries()) {
          const resolution = await resolveAttempt({
            model: entry.model,
            executionMode: entry.executionMode,
            attemptIndex: index,
            retryIndex: 0,
          });
          attempts.push(applyPolicyOptions({
            ...runOptions,
            model: entry.model,
            executionMode: entry.executionMode,
          }, resolution.policyOptions));
        }
        return { text: "ok" };
      },
    }));

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
      allowedTools: [...WORKLAB_BUILTIN_TOOLS],
      disallowedTools: [],
      fallbackChain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      model: { sdk: "codex" },
      executionMode: "cli",
      allowedTools: ["*"],
      disallowedTools: [],
    });
    expect(attempts[1]).toMatchObject({
      model: { sdk: "claude" },
      executionMode: "sdk",
      allowedTools: WORKLAB_BUILTIN_TOOLS,
      disallowedTools: [],
    });
  });

  it("projects the exact planning policy independently for Codex and Claude", async () => {
    const attempts = [];
    const onEvent = vi.fn();
    const planTools = [
      "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task",
      "TaskOutput", "TaskStop", "Skill", "Bash",
    ];
    mockCreateRouterRuntime.mockImplementationOnce(({ chain, resolveAttempt }) => ({
      run: async (_systemPrompt, runOptions) => {
        for (const [index, entry] of chain.entries()) {
          const resolution = await resolveAttempt({
            model: entry.model,
            executionMode: entry.executionMode,
            attemptIndex: index,
            retryIndex: 0,
          });
          attempts.push(applyPolicyOptions({
            ...runOptions,
            model: entry.model,
            executionMode: entry.executionMode,
          }, resolution.policyOptions));
        }
        return { text: "ok" };
      },
    }));

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
      allowedTools: planTools,
      disallowedTools: ["Write", "Edit"],
      toolPolicy: { planning: true, policy: "read_only_shell_allowlist" },
      fallbackChain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
      onEvent,
    });

    expect(attempts[0]).toMatchObject({
      model: { sdk: "codex" },
      allowedTools: ["*"],
      disallowedTools: [],
      permissionMode: "plan",
    });
    expect(attempts[1]).toMatchObject({
      model: { sdk: "claude" },
      allowedTools: planTools,
      disallowedTools: ["Write", "Edit"],
    });
    expect(attempts[1].permissionMode).toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "tool_policy_downgraded",
    }));
  });
});
