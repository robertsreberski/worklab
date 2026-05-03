import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";

describe("settings", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function runtimeServer(overrides = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-runtime-settings-"));
    dirs.push(dataDir);
    const config = {
      host: "127.0.0.1",
      port: 7878,
      dataDir,
      workspace: "/tmp/worklab-workspace",
      logLevel: "info",
      timezone: "",
      runIdleWarningMs: 120000,
      logInlineLimit: 12000,
      repoRoot: process.cwd(),
      ...overrides.config,
    };
    return makeTestServer({ dataDir, config, runtimeControls: overrides.runtimeControls });
  }

  it("GET returns defaults when empty", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.consolidation_hour).toBe(3);
    expect(res.body.settings.consolidation_enabled).toBe(true);
    expect(res.body.settings.worker_timeout_ms).toBe(1800000);
    expect(res.body.settings.default_embedding_model).toBe("");
    expect(res.body.settings.assistant_model).toBe("pi:openai:gpt-5.5");
    expect(res.body.settings.assistant_effort).toBe("high");
    expect(res.body.settings.assistant_run_timeout_ms).toBe(300000);
    expect(res.body.settings.assistant_max_turns).toBe(32);
    expect(res.body.settings.agent_budget_soft_turns).toBe(150);
    expect(res.body.settings.agent_budget_hard_turns).toBe(300);
    expect(res.body.settings.agent_compaction_trigger_ratio).toBe(0.85);
    expect(res.body.settings.agent_compaction_min_savings_tokens).toBe(20000);
    expect(res.body.settings.agent_tool_payload_compaction_trigger_chars).toBe(0);
    expect(res.body.settings.agent_tool_prune_trigger_tokens).toBe(40000);
    expect(res.body.settings.agent_tool_text_limit_chars).toBe(16000);
    expect(res.body.settings.agent_bash_output_limit_chars).toBe(20000);
    expect(res.body.settings.agent_mcp_text_limit_chars).toBe(12000);
    expect(res.body.settings.agent_search_result_limit).toBe(100);
    expect(res.body.settings.agent_provider_recovery_enabled).toBe(true);
    expect(res.body.settings.agent_provider_recovery_base_delay_ms).toBe(30000);
    expect(res.body.settings.delegation_enabled).toBe(true);
    expect(res.body.settings.delegation_max_depth).toBe(1);
    expect(res.body.settings.delegation_max_children_per_round).toBe(5);
    expect(res.body.settings.delegation_max_parallel_children).toBe(3);
    expect(res.body.settings.delegation_auto_run_children).toBe(true);
  });

  it("PATCH clears the embedding model when given empty string", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({
      default_embedding_model: "openai:text-embedding-3-small",
    }).expect(200);
    await agent.patch("/api/settings").send({ default_embedding_model: "" }).expect(200);
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.default_embedding_model).toBe("");
  });

  it("PATCH writes and GET reads back", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({
      consolidation_hour: 5,
      default_embedding_model: "openai:text-embedding-3-small",
      slack_enabled: true,
      slack_user_id: "UROBERT",
      slack_agent_name: "mickey",
      slack_model: "pi:openai-codex:gpt-5.5",
      slack_effort: "xhigh",
      slack_channel_ids: ["C1", "C2"],
      slack_run_timeout_ms: 60000,
      slack_notify_task_completed: true,
      slack_notify_task_errors: false,
      assistant_model: "pi:openai-codex:gpt-5.4",
      assistant_effort: "medium",
      assistant_run_timeout_ms: 45000,
      assistant_max_turns: 48,
      agent_budget_soft_turns: 400,
      agent_budget_hard_turns: 800,
      agent_provider_recovery_enabled: false,
      agent_provider_recovery_base_delay_ms: 1000,
      delegation_enabled: false,
      delegation_max_depth: 2,
      delegation_max_children_per_round: 7,
      delegation_max_parallel_children: 4,
      delegation_auto_run_children: false,
    }).expect(200);
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.consolidation_hour).toBe(5);
    expect(res.body.settings.default_embedding_model).toBe("openai:text-embedding-3-small");
    expect(res.body.settings.slack_enabled).toBe(true);
    expect(res.body.settings.slack_user_id).toBe("UROBERT");
    expect(res.body.settings.slack_channel_ids).toEqual(["C1", "C2"]);
    expect(res.body.settings.slack_notify_task_errors).toBe(false);
    expect(res.body.settings.assistant_model).toBe("pi:openai-codex:gpt-5.4");
    expect(res.body.settings.assistant_effort).toBe("medium");
    expect(res.body.settings.assistant_run_timeout_ms).toBe(45000);
    expect(res.body.settings.assistant_max_turns).toBe(48);
    expect(res.body.settings.agent_budget_soft_turns).toBe(400);
    expect(res.body.settings.agent_budget_hard_turns).toBe(800);
    expect(res.body.settings.agent_provider_recovery_enabled).toBe(false);
    expect(res.body.settings.agent_provider_recovery_base_delay_ms).toBe(1000);
    expect(res.body.settings.delegation_enabled).toBe(false);
    expect(res.body.settings.delegation_max_depth).toBe(2);
    expect(res.body.settings.delegation_max_children_per_round).toBe(7);
    expect(res.body.settings.delegation_max_parallel_children).toBe(4);
    expect(res.body.settings.delegation_auto_run_children).toBe(false);
  });

  it("PATCH canonicalizes legacy agent runtime model settings", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({
      slack_model: "codex:gpt-5.5",
      assistant_model: "openai:gpt-5.5",
    }).expect(200);
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.slack_model).toBe("pi:openai-codex:gpt-5.5");
    expect(res.body.settings.assistant_model).toBe("pi:openai:gpt-5.5");
  });

  it("PATCH rejects unknown keys", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ bogus: 1 }).expect(400);
  });

  it("PATCH rejects invalid delegation settings", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ delegation_enabled: "yes" }).expect(400);
    await agent.patch("/api/settings").send({ delegation_max_depth: -1 }).expect(400);
    await agent.patch("/api/settings").send({ delegation_max_children_per_round: 0 }).expect(400);
    await agent.patch("/api/settings").send({ delegation_max_parallel_children: 0 }).expect(400);
    await agent.patch("/api/settings").send({ delegation_auto_run_children: 1 }).expect(400);
  });

  it("PATCH rejects invalid agent turn budget settings", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ agent_budget_soft_turns: 0 }).expect(400);
    await agent.patch("/api/settings").send({ agent_budget_hard_turns: 10001 }).expect(400);
    await agent.patch("/api/settings").send({
      agent_budget_soft_turns: 900,
      agent_budget_hard_turns: 500,
    }).expect(400);

    await agent.patch("/api/settings").send({ agent_budget_hard_turns: 600 }).expect(200);
    await agent.patch("/api/settings").send({ agent_budget_soft_turns: 700 }).expect(400);
  });

  it("PATCH rejects tier aliases for embedding models", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ default_embedding_model: "sonnet" }).expect(400);
  });

  it("PATCH accepts vercel embedding references and canonicalizes legacy provider syntax", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({
      default_embedding_model: "provider:local:text-embedding-3-small",
    }).expect(200);
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.default_embedding_model).toBe("vercel:local:text-embedding-3-small");
  });

  it("GET runtime settings returns effective config and service status", async () => {
    const { agent } = runtimeServer({
      runtimeControls: { serviceStatus: async () => ({ platform: "test", installed: false }) },
    });
    const res = await agent.get("/api/settings/runtime").expect(200);
    expect(res.body.runtime.effective.port).toBe(7878);
    expect(res.body.runtime.desired.port).toBe(7878);
    expect(res.body.runtime.restartRequired).toBe(false);
    expect(res.body.runtime.service.installed).toBe(false);
    expect(res.body.runtime.readOnly.repoRoot).toBe(process.cwd());
  });

  it("PATCH runtime settings writes managed values to the data-dir .env", async () => {
    const { agent } = runtimeServer();
    await agent.patch("/api/settings/runtime").send({
      port: 9000,
      logLevel: "debug",
      timezone: "Europe/Amsterdam",
      runIdleWarningMs: 600000,
    }).expect(200);
    const res = await agent.get("/api/settings/runtime").expect(200);
    const envPath = res.body.runtime.envPath;
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toContain("WORKLAB_PORT=9000");
    expect(readFileSync(envPath, "utf8")).toContain("WORKLAB_LOG_LEVEL=debug");
    expect(readFileSync(envPath, "utf8")).toContain("WORKLAB_TIMEZONE=Europe/Amsterdam");
    expect(readFileSync(envPath, "utf8")).toContain("WORKLAB_RUN_IDLE_WARNING_MS=600000");
    expect(res.body.runtime.desired.port).toBe(9000);
    expect(res.body.runtime.restartRequired).toBe(true);
  });

  it("PATCH runtime settings rejects invalid values", async () => {
    const { agent } = runtimeServer();
    await agent.patch("/api/settings/runtime").send({ port: 70000 }).expect(400);
    await agent.patch("/api/settings/runtime").send({ timezone: "Not/AZone" }).expect(400);
    await agent.patch("/api/settings/runtime").send({ slackBotToken: "xoxb-secret" }).expect(400);
    await agent.patch("/api/settings/runtime").send({ bogus: true }).expect(400);
  });

  it("POST runtime restart requires an installed service", async () => {
    const { agent } = runtimeServer({
      runtimeControls: { serviceStatus: async () => ({ platform: "test", installed: false }) },
    });
    await agent.post("/api/settings/runtime/restart").expect(409);
  });

  it("POST runtime restart queues restart with desired values", async () => {
    let desired;
    const { agent } = runtimeServer({
      runtimeControls: {
        serviceStatus: async () => ({ platform: "test", installed: true }),
        restart: async (input) => {
          desired = input.desired;
          return { queued: true, pid: 123 };
        },
      },
    });
    await agent.patch("/api/settings/runtime").send({ port: 9001 }).expect(200);
    const res = await agent.post("/api/settings/runtime/restart").expect(202);
    expect(res.body.restart.queued).toBe(true);
    expect(desired.port).toBe(9001);
  });
});
