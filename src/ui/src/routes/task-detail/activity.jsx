import { AgentAvatar } from "../../components/AgentAvatar.jsx";
import { Icon } from "../../components/Icon.jsx";
import { normalizeCommentText, shouldHideComment } from "../../lib/commentFormatting.js";

export function commentAuthorLabel(item) {
  if (item.author?.display_name) return item.author.display_name;
  if (item.author?.id) return item.author.id;
  if (item.authorId) return item.authorId;
  if (item.authorType === "agent") return "Agent";
  if (item.authorType === "system") return "System";
  return "You";
}

export function ActivityRailDot({ item, agentLabel }) {
  const tone = item.type === "run" ? (item.run?.process_status || item.run?.status) : item.authorType;
  const runAgent = item.run?.agent_name;
  const commentAgent = item.authorType === "agent" ? item.authorId || item.author?.id : null;
  if (item.type === "run" && runAgent) {
    return (
      <span class={`activity-feed-dot avatar run ${tone || ""}`}>
        <AgentAvatar name={runAgent} label={agentLabel || runAgent} size={20} compact />
      </span>
    );
  }
  if (commentAgent) {
    return (
      <span class="activity-feed-dot avatar comment-dot agent">
        <AgentAvatar name={commentAgent} label={commentAuthorLabel(item)} size={20} compact />
      </span>
    );
  }
  const icon = item.type === "run" ? "zap" : "message-circle";
  const typeClass = item.type === "comment" ? "comment-dot" : item.type;
  return (
    <span class={`activity-feed-dot ${typeClass} ${tone || ""}`}>
      {item.authorType === "human" ? <span class="activity-feed-human-mark">@</span> : <Icon name={icon} size={12} />}
    </span>
  );
}

// One entry per run (not two), sorted by completion time when present.
export function buildActivity({ comments = [], runs = [] }) {
  const items = [];
  for (const c of comments) {
    if (shouldHideComment(c)) continue;
    items.push({
      type: "comment",
      at: c.created_at || 0,
      author: c.author,
      authorType: c.author_type || c.author?.type || "human",
      authorId: c.author_id || c.author?.id || null,
      body: normalizeCommentText(c.body || c.content || ""),
      commentId: c.id || null,
      id: `c-${c.id || c.created_at}`,
    });
  }
  for (const r of runs) {
    items.push({
      type: "run",
      at: r.ended_at || r.started_at || 0,
      run: r,
      id: `r-${r.id}`,
    });
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  return items;
}
