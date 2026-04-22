// src/ui/src/components/CommentList.jsx
import { CommentAuthor } from "./CommentAuthor.jsx";
import { MarkdownContent } from "./Markdown.jsx";

const VERDICT_RE = /^VERDICT:\s*(APPROVE|REJECT)\b/;

function parseVerdict(body, authorType) {
  if ((authorType || "").toLowerCase() !== "system") return { verdict: null, body };
  const match = VERDICT_RE.exec(body || "");
  if (!match) return { verdict: null, body };
  const verdict = match[1]; // "APPROVE" or "REJECT"
  const rest = body.slice(match[0].length).trimStart();
  return { verdict, body: rest };
}

export function CommentList({ comments }) {
  if (!comments?.length) return <div class="meta">No comments yet.</div>;
  return (
    <div class="comment-list">
      {comments.map((c) => {
        const { verdict, body: displayBody } = parseVerdict(c.body, c.author_type);
        return (
          <div key={c.id} class="comment">
            <div class="author" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <CommentAuthor authorType={c.author_type} authorId={c.author_id} />
              {verdict && (
                <span class={`verdict-badge ${verdict.toLowerCase()}`}>{verdict}</span>
              )}
              <span style="margin-left:auto;font-size:11px;color:var(--muted);">
                {new Date(c.created_at).toLocaleString()}
              </span>
            </div>
            {displayBody && <MarkdownContent content={displayBody} className="comment-body doc-content" />}
          </div>
        );
      })}
    </div>
  );
}
