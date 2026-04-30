import { readSettings } from "../../core/settings.js";

function fallbackStatus(db, config) {
  const settings = readSettings(db);
  return {
    enabled: !!settings.slack_enabled,
    connected: false,
    reason: settings.slack_enabled ? "not_started" : "disabled",
    token_present: {
      bot: !!config?.slackBotToken,
      app: !!config?.slackAppToken,
    },
    bot_user_id: null,
    last_event: null,
    last_rejected: null,
    last_error: null,
    last_inbound: null,
    last_run: null,
    last_delivery: null,
  };
}

export function registerSlackRoutes(app, { db, config, slack }) {
  app.get("/api/slack/status", (_req, res) => {
    try {
      res.json({ slack: slack?.status?.() || fallbackStatus(db, config) });
    } catch (err) {
      res.status(500).json({ error: { code: "slack_status_failed", message: err.message } });
    }
  });
}
