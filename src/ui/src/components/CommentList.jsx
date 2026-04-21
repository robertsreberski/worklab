// src/ui/src/components/CommentList.jsx
export function CommentList({ comments }) {
  if (!comments?.length) return <div class="meta">No comments yet.</div>;
  return (
    <div class="comment-list">
      {comments.map((c) => (
        <div key={c.id} class="comment">
          <div class="author">
            {c.author_type} {c.author_id ? `· ${c.author_id}` : ""} ·{" "}
            {new Date(c.created_at).toLocaleString()}
          </div>
          <div>{c.body}</div>
        </div>
      ))}
    </div>
  );
}
