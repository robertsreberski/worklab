// src/ui/src/components/CommentList.jsx
import { CommentAuthor } from "./CommentAuthor.jsx";
import { StructuredContent } from "./StructuredContent.jsx";
import { SectionStack } from "./layout/index.js";
import { mergeAgentReferenceMentions } from "../lib/agentLinks.js";
import { normalizeCommentText, parseVerdictComment, shouldHideComment } from "../lib/commentFormatting.js";

export function CommentList({ comments, agents = [], mentions = null }) {
  const visibleComments = (comments || []).filter((c) => !shouldHideComment(c));
  const resolvedMentions = mergeAgentReferenceMentions(mentions, agents);
  if (!visibleComments.length) return <div class="meta">No comments yet.</div>;
  return (
    <SectionStack class="comment-list">
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
            {displayBody && <StructuredContent content={displayBody} className="comment-body doc-content" mentions={resolvedMentions} />}
          </div>
        );
      })}
    </SectionStack>
  );
}
