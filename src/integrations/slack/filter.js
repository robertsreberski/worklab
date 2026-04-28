export function slackMessageFilterReason(event, config = {}) {
  if (!event || event.type !== "message") return "not_message";
  if (event.subtype) return "subtype";
  if (event.bot_id) return "bot";
  if (event.hidden) return "hidden";
  if (!event.user) return "missing_user";
  if (config.botUserId && event.user === config.botUserId) return "self";
  if (!event.channel) return "missing_channel";
  if (!event.ts) return "missing_ts";
  const text = String(event.text || "").trim();
  if (!text) return "empty_text";

  const channelType = event.channel_type || "";
  if (channelType === "im") {
    if (config.slackUserId && event.user !== config.slackUserId) return "wrong_dm_user";
    return null;
  }

  const allowed = new Set(config.slackChannelIds || []);
  if (allowed.size > 0 && !allowed.has(event.channel)) return "channel_not_allowlisted";
  return null;
}

export function shouldProcessSlackMessage(event, config = {}) {
  return slackMessageFilterReason(event, config) === null;
}
