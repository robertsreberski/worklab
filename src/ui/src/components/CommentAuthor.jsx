// src/ui/src/components/CommentAuthor.jsx

function HumanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="7" cy="4.5" r="2.5" fill="currentColor" />
      <path d="M2 13c0-2.761 2.239-5 5-5s5 2.239 5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* antenna */}
      <line x1="7" y1="1" x2="7" y2="3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      <circle cx="7" cy="1" r="0.8" fill="currentColor" />
      {/* square head */}
      <rect x="2.5" y="3.5" width="9" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none" />
      {/* eyes */}
      <circle cx="5" cy="7" r="1" fill="currentColor" />
      <circle cx="9" cy="7" r="1" fill="currentColor" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4" fill="none" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </svg>
  );
}

const ICONS = { human: HumanIcon, agent: AgentIcon, system: SystemIcon };

export function CommentAuthor({ authorType, authorId }) {
  const type = (authorType || "system").toLowerCase();
  const Icon = ICONS[type] || SystemIcon;
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const authorLink = type === "agent" && authorId ? `#/agents/${authorId}` : null;

  return (
    <span class={`comment-author ${type}`}>
      <Icon />
      <span>{label}</span>
      {authorId && (
        authorLink
          ? <a class="author-id" href={authorLink}>{authorId}</a>
          : <span class="author-id">{authorId}</span>
      )}
    </span>
  );
}
