import { App } from "@slack/bolt";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendJournalEntry,
  appendJournalSummary,
  appendMemoryFacts,
  generateResponse,
  getAvailableMcpServers,
  loadSkills,
  newAgentLogId,
  newRunId,
  newSlackDeliveryId,
  newSlackInboundEventId,
  readAgentMemoryContent,
  readJournalTail,
  readSettings,
  resolveModel,
  worklabBaseUrl,
  WORKLAB_BUILTIN_TOOLS,
} from "../../core/index.js";
import { buildTriageMessages, buildTriageSystemPrompt } from "./context.js";
import { slackMessageFilterReason } from "./filter.js";
import { parseTriageResult, TRIAGE_RESULT_JSON_SCHEMA } from "./triage-result.js";
import { getTaskById } from "../../core/db/queries/tasks.js";
import { expandMentionsForLlm } from "../../core/index.js";

function expandSlackInputMentions(db, dataDir, input) {
  if (!input) return input;
  const next = { ...input };
  if (typeof input.text === "string" && input.text.length > 0) {
    next.text = expandMentionsForLlm(db, input.text, { dataDir });
  }
  if (typeof input.title === "string" && input.title.length > 0) {
    next.title = expandMentionsForLlm(db, input.title, { dataDir });
  }
  return next;
}

function stringify(value) {
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || "{}"); } catch { return fallback; }
}

function usageInt(usage, key) {
  return Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : null;
}

function usageNumber(usage, key) {
  return Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : null;
}

function abortSignalWithTimeout(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return undefined;
  if (AbortSignal.timeout) return AbortSignal.timeout(Number(ms));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), Number(ms)).unref?.();
  return ac.signal;
}

function rawLogPath(dataDir, runId) {
  const dir = join(dataDir, "logs", "slack-triage");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runId}.jsonl`);
}

function slackSourceKey(event, body) {
  return `slack:${body?.event_id || event.client_msg_id || `${event.channel}:${event.ts}`}`;
}

function rowToInput(row) {
  const payload = parseJson(row.payload_json);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    text: row.text,
    channel_id: row.channel_id,
    user_id: row.user_id,
    thread_ts: row.thread_ts,
    message_ts: row.message_ts,
    metadata: payload.metadata || {},
    raw: payload,
  };
}

function taskRoute(config, task, runId) {
  const taskId = encodeURIComponent(task?.task_key || task?.id || "");
  const runParam = runId ? `?run=${encodeURIComponent(runId)}` : "";
  return `${worklabBaseUrl(config)}/#/tasks/${taskId}${runParam}`;
}

function taskLabel(task) {
  return [task?.task_key, task?.title || task?.id].filter(Boolean).join(" - ");
}

function classifyTaskNotification({ event, task }) {
  const processStatus = event?.processStatus || event?.process_status || event?.status;
  const failed = ["failed", "error", "abandoned"].includes(processStatus)
    || (!!event?.failureKind && task?.stage !== "done");
  if (task?.stage === "done" && ["succeeded", "complete"].includes(processStatus)) return "completed";
  if (task?.stage === "blocked" || failed) return "error";
  return null;
}

function formatTaskNotification({ kind, task, event, config }) {
  const label = taskLabel(task) || "Task";
  const url = taskRoute(config, task, event?.runId);
  if (kind === "completed") {
    const summary = event?.summary || task?.stage_reason || "";
    return [
      `[completed] Worklab task completed: ${label}`,
      summary ? `Summary: ${summary}` : "",
      `Open: ${url}`,
    ].filter(Boolean).join("\n");
  }
  const reason = event?.errorText || event?.failureKind || task?.error_text || task?.stage_reason || "Run failed.";
  return [
    `[error] Worklab task needs attention: ${label}`,
    `Reason: ${reason}`,
    `Open: ${url}`,
  ].filter(Boolean).join("\n");
}

function adminMcpServer(config) {
  return {
    command: process.execPath,
    args: [join(config.repoRoot, "src", "cli", "index.js"), "mcp"],
    env: {
      WORKLAB_DATA_DIR: config.dataDir,
      WORKLAB_HOST: config.host,
      WORKLAB_PORT: String(config.port),
      WORKLAB_WORKSPACE: config.workspace,
    },
  };
}

function slackMcpServers(config) {
  return {
    ...getAvailableMcpServers(config.dataDir, { repoRoot: config.repoRoot }),
    worklab: adminMcpServer(config),
  };
}

export function createThrottledSlackLogger(logger, { throttleMs = 30_000, now = Date.now } = {}) {
  if (!logger) return undefined;
  const lastByKey = new Map();
  const write = (level, args) => {
    const message = args.map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.message;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).filter(Boolean).join(" ");
    const key = `${level}:${message}`;
    const time = now();
    if (level === "warn" && time - (lastByKey.get(key) || 0) < throttleMs) return;
    lastByKey.set(key, time);
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "debug";
    logger?.[method]?.({ source: "slack-bolt" }, message || "slack log");
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    setLevel: () => {},
    getLevel: () => "INFO",
    setName: () => {},
  };
}

export function createSlackApp({ config, logger }) {
  return new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logger: createThrottledSlackLogger(logger),
  });
}

function timeoutError(reason) {
  const err = new Error(reason);
  err.code = reason;
  return err;
}

function withTimeout(promise, timeoutMs, reason) {
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(reason)), Number(timeoutMs));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class WorklabSlackService {
  constructor({
    db,
    config,
    logger,
    events,
    appFactory = createSlackApp,
    runAgent = generateResponse,
  }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.appFactory = appFactory;
    this.runAgent = runAgent;
    this.queue = Promise.resolve();
    this.app = null;
    this.slackClient = null;
    this.running = false;
    this.botUserId = "";
    this.state = {
      enabled: false,
      connected: false,
      reason: "not_started",
      lastEvent: null,
      lastRejected: null,
      lastError: null,
      startedAt: null,
    };
    this.sentTaskNotifications = new Set();
    this.onSettingsUpdated = ({ keys } = {}) => {
      if (!keys || keys.some((key) => key.startsWith("slack_"))) this.refresh().catch((err) => {
        this.logger?.warn?.({ err }, "slack refresh failed");
      });
    };
    this.onRunEnded = (event) => {
      this.notifyTaskRunEnded(event).catch((err) => {
        this.logger?.warn?.({ err, runId: event?.runId }, "slack task notification failed");
      });
    };
    this.events?.on?.("settings:updated", this.onSettingsUpdated);
    this.events?.on?.("run:ended", this.onRunEnded);
  }

  currentSettings() {
    return readSettings(this.db);
  }

  runtimeReady() {
    return !!(this.config.slackBotToken && this.config.slackAppToken);
  }

  async start({ timeoutMs = 5000 } = {}) {
    const settings = this.currentSettings();
    this.state.enabled = !!settings.slack_enabled;
    if (!settings.slack_enabled) {
      this.state = { ...this.state, connected: false, reason: "disabled" };
      return this.status();
    }
    if (!this.runtimeReady()) {
      this.state = { ...this.state, connected: false, reason: "missing_tokens" };
      return this.status();
    }
    if (this.running) return this.status();

    try {
      this.app = this.appFactory({ config: this.config, logger: this.logger });
      this.slackClient = this.app.client;
      this.app.event("message", async ({ event, body }) => {
        await this.handleSlackMessage({ event, body });
      });
      try {
        const auth = await this.slackClient?.auth?.test?.();
        this.botUserId = auth?.user_id || auth?.bot_id || "";
      } catch (err) {
        this.logger?.warn?.({ err }, "slack auth.test failed");
      }
      await withTimeout(this.app.start(), timeoutMs, "start_timeout");
    } catch (err) {
      const timedOut = err?.code === "start_timeout";
      this.state = {
        ...this.state,
        enabled: true,
        connected: false,
        reason: timedOut ? "start_timeout" : "start_failed",
        lastError: err.message || String(err),
      };
      this.logger?.warn?.({ err }, timedOut ? "slack integration start timed out" : "slack integration failed to start");
      await this.stop(timedOut ? "start_timeout" : "start_failed");
      return this.status();
    }
    this.running = true;
    this.state = {
      ...this.state,
      enabled: true,
      connected: true,
      reason: "connected",
      startedAt: Date.now(),
      lastError: null,
    };
    this.logger?.info?.("slack integration started");
    return this.status();
  }

  async stop(reason = "stopped") {
    if (this.app) {
      try { await this.app.stop(); } catch (err) { this.logger?.warn?.({ err }, "slack stop failed"); }
    }
    this.app = null;
    this.slackClient = null;
    this.running = false;
    this.botUserId = "";
    this.state = { ...this.state, connected: false, reason };
  }

  async refresh() {
    const settings = this.currentSettings();
    if (!settings.slack_enabled || !this.runtimeReady()) {
      await this.stop(!settings.slack_enabled ? "disabled" : "missing_tokens");
      this.state.enabled = !!settings.slack_enabled;
      return this.status();
    }
    if (!this.running) return this.start();
    this.state.enabled = true;
    return this.status();
  }

  async shutdown() {
    this.events?.off?.("settings:updated", this.onSettingsUpdated);
    this.events?.off?.("run:ended", this.onRunEnded);
    await this.waitIdle();
    await this.stop("shutdown");
  }

  waitIdle() {
    return this.queue;
  }

  status() {
    const settings = this.currentSettings();
    const lastInbound = this.db.prepare(
      "SELECT id, type, status, error_text, received_at, processed_at FROM slack_inbound_events ORDER BY received_at DESC LIMIT 1",
    ).get() || null;
    const lastRun = this.db.prepare(
      "SELECT id, inbound_event_id, status, model, effort, summary, error_text, started_at, ended_at FROM slack_triage_runs ORDER BY started_at DESC LIMIT 1",
    ).get() || null;
    const lastDelivery = this.db.prepare(
      "SELECT id, target_type, status, error_text, created_at FROM slack_delivery_log ORDER BY created_at DESC LIMIT 1",
    ).get() || null;
    return {
      enabled: !!settings.slack_enabled,
      connected: this.running && this.state.connected,
      reason: this.state.reason,
      token_present: {
        bot: !!this.config.slackBotToken,
        app: !!this.config.slackAppToken,
      },
      bot_user_id: this.botUserId || null,
      last_event: this.state.lastEvent,
      last_rejected: this.state.lastRejected,
      last_error: this.state.lastError,
      last_inbound: lastInbound,
      last_run: lastRun,
      last_delivery: lastDelivery,
    };
  }

  handleSlackMessage({ event, body }) {
    const settings = this.currentSettings();
    const meta = {
      channel: event?.channel || null,
      user: event?.user || null,
      ts: event?.ts || null,
      subtype: event?.subtype || null,
    };
    this.state.lastEvent = { ...meta, received_at: Date.now() };
    this.logger?.info?.(meta, "slack message event received");
    const reason = slackMessageFilterReason(event, {
      botUserId: this.botUserId,
      slackUserId: settings.slack_user_id,
      slackChannelIds: settings.slack_channel_ids,
    });
    if (reason) {
      this.state.lastRejected = { ...meta, reason, received_at: Date.now() };
      this.logger?.info?.({ ...meta, reason }, "slack message event rejected");
      return { queued: false, duplicate: false, rejected: reason };
    }
    try {
      const queued = this.enqueueSlackMessage({ event, body });
      this.logger?.info?.({ ...meta, eventId: queued.id, queued: queued.queued, duplicate: queued.duplicate }, "slack message event enqueued");
      return queued;
    } catch (err) {
      this.state.lastError = err.message || String(err);
      this.logger?.error?.({ err, ...meta }, "failed to enqueue slack message");
      throw err;
    }
  }

  enqueueSlackMessage({ event, body }) {
    const id = newSlackInboundEventId();
    const now = Date.now();
    const sourceKey = slackSourceKey(event, body);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO slack_inbound_events
        (id, source_key, type, title, text, channel_id, user_id, thread_ts, message_ts, payload_json, received_at)
      VALUES (?, ?, 'slack_message', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sourceKey,
      `Slack message from ${event.user}`,
      String(event.text || ""),
      event.channel || null,
      event.user || null,
      event.thread_ts || event.ts || null,
      event.ts || null,
      stringify({ event, body }),
      now,
    );
    if (result.changes === 0) {
      const existing = this.db.prepare("SELECT id FROM slack_inbound_events WHERE source_key = ?").get(sourceKey);
      return { id: existing?.id || null, queued: false, duplicate: true };
    }
    this.schedule(id);
    return { id, queued: true, duplicate: false };
  }

  schedule(id) {
    this.queue = this.queue
      .then(() => this.processEvent(id))
      .catch((err) => {
        this.state.lastError = err.message || String(err);
        this.logger?.error?.({ err, id }, "slack triage event failed");
      });
    return this.queue;
  }

  async processEvent(id) {
    const row = this.db.prepare("SELECT * FROM slack_inbound_events WHERE id = ?").get(id);
    if (!row || row.status === "succeeded" || row.status === "running") return null;
    const settings = this.currentSettings();
    const runId = newRunId();
    const startedAt = Date.now();
    const logPath = rawLogPath(this.config.dataDir, runId);
    const agentName = settings.slack_agent_name || "mickey";

    this.db.prepare("UPDATE slack_inbound_events SET status = 'running', error_text = NULL WHERE id = ?").run(id);
    this.db.prepare(`
      INSERT INTO slack_triage_runs
        (id, inbound_event_id, status, model, effort, started_at, raw_output_path)
      VALUES (?, ?, 'running', ?, ?, ?, ?)
    `).run(runId, id, settings.slack_model, settings.slack_effort, startedAt, logPath);

    const events = [];
    const input = expandSlackInputMentions(this.db, this.config.dataDir, rowToInput(row));
    const skills = loadSkills(join(this.config.dataDir, "skills")).filter((skill) => skill.enabled !== false);
    const memory = readAgentMemoryContent({ dataDir: this.config.dataDir, agent: agentName });
    const journalTail = readJournalTail({
      dataDir: this.config.dataDir,
      agent: agentName,
      maxLines: settings.journal_tail_lines,
    });
    const systemPrompt = buildTriageSystemPrompt({ agentName, memory, journalTail, input, skills });
    const slackStatusActive = await this.setSlackStatus({ row, status: "is working on your request..." });

    try {
      const model = resolveModel(settings.slack_model);
      const mcpServers = slackMcpServers(this.config);
      const response = await this.runAgent(systemPrompt, {
        model,
        effort: settings.slack_effort || "medium",
        db: this.db,
        dataDir: this.config.dataDir,
        skills,
        messages: buildTriageMessages(input),
        cwd: this.config.workspace,
        mcpServers,
        allowedTools: [
          ...WORKLAB_BUILTIN_TOOLS,
          ...Object.keys(mcpServers).flatMap((name) => [`mcp__${name}`, `mcp__${name}__*`]),
        ],
        disallowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 8,
        outputSchema: TRIAGE_RESULT_JSON_SCHEMA,
        abortSignal: abortSignalWithTimeout(settings.slack_run_timeout_ms),
        onEvent: (event) => {
          events.push(event);
          appendFileSync(logPath, `${JSON.stringify(event)}\n`);
        },
      });
      if (response.cancelled) throw new Error("slack triage cancelled");
      if (response.error) throw new Error(response.error);

      const triage = parseTriageResult(response.text);
      await this.applyTriage({ row, runId, triage, settings });

      this.db.prepare(`
        UPDATE slack_triage_runs
        SET status = 'succeeded', ended_at = ?, input_tokens = ?, output_tokens = ?,
            cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?,
            duration_ms = ?, num_turns = ?, summary = ?, final_json = ?
        WHERE id = ?
      `).run(
        Date.now(),
        usageInt(response.usage, "input_tokens"),
        usageInt(response.usage, "output_tokens"),
        usageInt(response.usage, "cache_read_input_tokens") ?? usageInt(response.usage, "cache_read_tokens"),
        usageInt(response.usage, "cache_creation_input_tokens") ?? usageInt(response.usage, "cache_creation_tokens"),
        usageNumber(response.usage, "cost_usd"),
        response.durationMs || null,
        response.numTurns || null,
        triage.summary,
        JSON.stringify(triage),
        runId,
      );
      this.db.prepare("UPDATE slack_inbound_events SET status = 'succeeded', processed_at = ? WHERE id = ?").run(Date.now(), row.id);
      this.writeAgentLog({ runId, events: response.events || events, status: "succeeded" });
      return triage;
    } catch (err) {
      const message = err?.message || String(err);
      this.db.prepare("UPDATE slack_triage_runs SET status = 'failed', ended_at = ?, error_text = ? WHERE id = ?")
        .run(Date.now(), message, runId);
      this.db.prepare("UPDATE slack_inbound_events SET status = 'failed', error_text = ?, processed_at = ? WHERE id = ?")
        .run(message, Date.now(), row.id);
      this.writeAgentLog({ runId, events, status: "failed" });
      this.state.lastError = message;
      this.logger?.error?.({ err, eventId: row.id, runId }, "slack triage failed");
      return null;
    } finally {
      if (slackStatusActive) await this.setSlackStatus({ row, status: "" });
    }
  }

  writeAgentLog({ runId, events, status }) {
    this.db.prepare(`
      INSERT INTO slack_agent_logs (id, slack_triage_run_id, events, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(newAgentLogId(), runId, JSON.stringify(events || []), status, Date.now());
  }

  async setSlackStatus({ row, status }) {
    const channelId = row.channel_id;
    const threadTs = row.thread_ts || row.message_ts;
    const threads = this.slackClient?.assistant?.threads;
    if (!channelId || !threadTs || typeof threads?.setStatus !== "function") return false;
    try {
      await threads.setStatus({ channel_id: channelId, thread_ts: threadTs, status });
      return true;
    } catch (err) {
      this.logger?.warn?.({ err, eventId: row.id, channel: channelId, threadTs, status }, "slack status update failed");
      return false;
    }
  }

  async applyTriage({ row, runId, triage, settings }) {
    const agentName = settings.slack_agent_name || "mickey";
    const bullets = triage.journal_bullets.length ? triage.journal_bullets : [triage.summary];
    for (const bullet of bullets) {
      appendJournalEntry({
        dataDir: this.config.dataDir,
        agent: agentName,
        runId,
        taskId: `slack:${row.id}`,
        taskTitle: row.title || "Slack message",
        bullet,
      });
    }
    if (triage.action_items.length) {
      appendJournalEntry({
        dataDir: this.config.dataDir,
        agent: agentName,
        runId,
        taskId: `slack:${row.id}`,
        taskTitle: row.title || "Slack message",
        bullet: `Action items: ${triage.action_items.join("; ")}`,
      });
    }
    appendJournalSummary({ dataDir: this.config.dataDir, agent: agentName, runId, text: triage.summary });
    appendMemoryFacts({ dataDir: this.config.dataDir, agent: agentName, runId, facts: triage.memory_facts });

    let postedSlackReply = false;
    if (triage.should_reply && triage.reply_text) {
      await this.postSlackMessage({
        runId,
        inboundEventId: row.id,
        targetType: "slack_channel",
        channel: row.channel_id,
        threadTs: row.thread_ts || row.message_ts,
        text: triage.reply_text,
      });
      postedSlackReply = true;
    }

    if (triage.notify_user) {
      await this.postUserDm({
        runId,
        inboundEventId: row.id,
        text: triage.user_message || triage.summary,
        settings,
        targetType: "slack_dm",
      });
    }
    return { postedSlackReply };
  }

  async postSlackMessage({ runId, inboundEventId, taskRunId, targetType, channel, threadTs, text, userId }) {
    const deliveryId = newSlackDeliveryId();
    const createdAt = Date.now();
    try {
      const response = await this.slackClient.chat.postMessage({
        channel,
        thread_ts: threadTs || undefined,
        text,
      });
      this.db.prepare(`
        INSERT INTO slack_delivery_log
          (id, slack_triage_run_id, inbound_event_id, task_run_id, target_type, channel_id, user_id, thread_ts, message_ts, text, status, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?)
      `).run(deliveryId, runId || null, inboundEventId || null, taskRunId || null, targetType, channel, userId || null, threadTs || null, response.ts || null, text, stringify(response), createdAt);
      return response;
    } catch (err) {
      const message = err?.message || String(err);
      this.db.prepare(`
        INSERT INTO slack_delivery_log
          (id, slack_triage_run_id, inbound_event_id, task_run_id, target_type, channel_id, user_id, thread_ts, text, status, error_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?)
      `).run(deliveryId, runId || null, inboundEventId || null, taskRunId || null, targetType, channel || null, userId || null, threadTs || null, text, message, createdAt);
      throw err;
    }
  }

  async postUserDm({ runId, inboundEventId, taskRunId, text, settings = this.currentSettings(), targetType = "slack_dm" }) {
    if (!settings.slack_user_id) throw new Error("slack_user_id is required for DM delivery");
    const opened = await this.slackClient.conversations.open({ users: settings.slack_user_id });
    const channel = opened.channel?.id;
    if (!channel) throw new Error("Slack conversations.open did not return a channel id");
    return this.postSlackMessage({
      runId,
      inboundEventId,
      taskRunId,
      targetType,
      channel,
      threadTs: null,
      text,
      userId: settings.slack_user_id,
    });
  }

  async notifyTaskRunEnded(event) {
    const settings = this.currentSettings();
    if (!settings.slack_enabled || !this.running || !this.slackClient || !settings.slack_user_id) return null;
    if (!event?.runId || !event?.taskId) return null;
    const task = getTaskById(this.db, event.taskId);
    if (!task) return null;
    const kind = classifyTaskNotification({ event, task });
    if (!kind) return null;
    if (kind === "completed" && !settings.slack_notify_task_completed) return null;
    if (kind === "error" && !settings.slack_notify_task_errors) return null;
    const dedupeKey = `${event.runId}:${kind}`;
    if (this.sentTaskNotifications.has(dedupeKey)) return null;
    this.sentTaskNotifications.add(dedupeKey);
    const text = formatTaskNotification({ kind, task, event, config: this.config });
    return this.postUserDm({
      taskRunId: event.runId,
      text,
      settings,
      targetType: `slack_task_${kind}`,
    });
  }
}

export function createWorklabSlackService(options) {
  return new WorklabSlackService(options);
}
