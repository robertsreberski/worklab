export function enrichCommentRows(db, comments = []) {
  if (!comments.length) return [];

  const agentRows = db.prepare("SELECT name, display_name FROM agents").all();
  const agentsByName = new Map(agentRows.map((agent) => [agent.name, agent]));

  return comments.map((comment) => {
    const author = {
      type: comment.author_type || "system",
      id: comment.author_id || null,
    };
    if (author.type === "agent" && author.id) {
      const agent = agentsByName.get(author.id);
      if (agent?.display_name) author.display_name = agent.display_name;
    }
    return { ...comment, author };
  });
}
