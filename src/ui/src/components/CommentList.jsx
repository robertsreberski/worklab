// src/ui/src/components/CommentList.jsx
import { CommentAuthor } from "./CommentAuthor.jsx";
import { StructuredContent } from "./StructuredContent.jsx";
import { linkAgentReferencesInMarkdown } from "../lib/agentLinks.js";
import { normalizeCommentText, parseVerdictComment, shouldHideComment } from "../lib/commentFormatting.js";

export function CommentList({ comments, agents = [] }) {
  const visibleComments = (comments || []).filter((c) => !shouldHideComment(c));
  if (!visibleComments.length) return <div class="meta">No comments yet.</div>;
  return (
    <div class="comment-list">
      {visibleComments.map((c) => {
        const { verdict, body } = parseVerdictComment(c.body, c.author_type);
        const displayBody = normalizeCommentText(body);
        return (
          <div key={c.id} class="comment">
            <div class="author comment-head">
              <CommentAuthor authorType={c.author_type} authorId={c.author_id} agents={agents} />
              {verdict && (
                <span class={`verdict-badge ${verdict.toLowerCase()}`}>{verdict}</span>
              )}
              <span class="comment-time">
                {new Date(c.created_at).toLocaleString()}
              </span>
            </div>
            {displayBody && <StructuredContent content={linkAgentReferencesInMarkdown(displayBody, agents)} className="comment-body doc-content" />}
          </div>
        );
      })}
    </div>
  );
}
