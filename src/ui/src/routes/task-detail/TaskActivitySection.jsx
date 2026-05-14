import { AgentLink } from "../../components/AgentLink.jsx";
import { AttachmentChips } from "../../components/AttachmentChips.jsx";
import { Card } from "../../components/Card.jsx";
import { Icon } from "../../components/Icon.jsx";
import { IconButton } from "../../components/primitives/IconButton.jsx";
import { Button } from "../../components/primitives/Button.jsx";
import { Checkbox } from "../../components/primitives/Checkbox.jsx";
import { MentionableTextarea } from "../../components/MentionableTextarea.jsx";
import { StructuredContent } from "../../components/StructuredContent.jsx";
import { InlineHead, Toolbar } from "../../components/layout/index.js";
import { agentDisplayName } from "../../lib/display.js";
import { ActivityRailDot, commentAuthorLabel } from "./activity.jsx";
import { formatActivityTime, formatDate } from "./format.js";
import { RunCard } from "./RunCards.jsx";

function ActivityCommentAuthor({ item, agents }) {
  const agentName = item.authorType === "agent" ? item.authorId || item.author?.id : null;
  if (agentName) {
    return (
      <AgentLink
        name={agentName}
        label={commentAuthorLabel(item)}
        agents={agents}
        badge={false}
        class="activity-author-name agent"
      />
    );
  }
  return <span class={`activity-author-badge ${item.authorType || "human"}`}>{commentAuthorLabel(item)}</span>;
}

export function TaskActivitySection({
  activity,
  agents,
  commentAttachments,
  commentAttachmentError,
  commentAttachmentUploading,
  commentRerun,
  commentSaving,
  displayActivity,
  expandedRunIds,
  highlightedRunId,
  loadFullRunHistory,
  newComment,
  onCommentAttachmentChange,
  onCommentAttachmentDragOver,
  onCommentAttachmentDrop,
  onCommentAttachmentPaste,
  onCommentRerunChange,
  onCommentSubmit,
  onCommentTextChange,
  onDeleteComment,
  onRunToggle,
  onSetRunTarget,
  onShowOlderActivity,
  resolvedMentions,
  runHistoryLoading,
  runningRun,
  runsNextCursor,
  showOlderActivity,
  task,
}) {
  return (
    <Card
      title="Activity"
      class="activity-card"
      headerRight={runsNextCursor ? (
        <Button variant="ghost" size="sm" loading={runHistoryLoading} onClick={loadFullRunHistory}>
          Load full history
        </Button>
      ) : null}
    >
      <div class="activity-composer">
        <form onSubmit={onCommentSubmit} class="activity-composer-form">
          <MentionableTextarea
            rows={1}
            autoGrow
            class="activity-composer-input"
            placeholder="Add a comment or instruction..."
            value={newComment}
            onInput={(event) => onCommentTextChange(event.target.value)}
            onPaste={onCommentAttachmentPaste}
            onDragOver={onCommentAttachmentDragOver}
            onDrop={onCommentAttachmentDrop}
            pathContext={{ taskId: task?.id, projectId: task?.project_id }}
          />
          <AttachmentChips
            attachments={commentAttachments}
            onChange={onCommentAttachmentChange}
            uploading={commentAttachmentUploading}
            uploadError={commentAttachmentError}
          />
          <Toolbar class="activity-composer-actions">
            <div class="activity-composer-options">
              <Checkbox
                class="activity-rerun-checkbox"
                checked={commentRerun && !runningRun}
                disabled={Boolean(runningRun)}
                onChange={onCommentRerunChange}
                label="Rerun task"
              />
              <span class="activity-composer-shortcut">Cmd Enter</span>
            </div>
            <Button type="submit" variant="primary" disabled={!newComment.trim() || commentSaving}>
              {commentSaving ? "Posting..." : commentRerun && !runningRun ? "Post & run" : "Post"}
            </Button>
          </Toolbar>
        </form>
      </div>

      {displayActivity.length > 0 ? (
        <div class="activity-feed">
          {displayActivity.map((item) => {
            if (item.type === "run") {
              const run = item.run;
              return (
                <div key={item.id} class="activity-feed-entry run" ref={(node) => onSetRunTarget(run.id, node)}>
                  <div class="activity-feed-rail">
                    <ActivityRailDot item={item} agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)} />
                  </div>
                  <div class="activity-feed-content">
                    <RunCard
                      run={run}
                      expanded={expandedRunIds.has(run.id)}
                      highlighted={highlightedRunId === run.id}
                      onToggle={onRunToggle}
                      subscribe={(run.process_status || run.status) === "running"}
                      agents={agents}
                    />
                  </div>
                </div>
              );
            }
            const canDeleteComment = item.authorType === "human" && item.commentId;
            return (
              <div key={item.id} class={`activity-feed-entry comment ${item.authorType || "human"}`}>
                <div class="activity-feed-rail"><ActivityRailDot item={item} /></div>
                <div class="activity-feed-content activity-item">
                  <InlineHead class="activity-item-head">
                    <ActivityCommentAuthor item={item} agents={agents} />
                    <span class="activity-item-time" title={formatDate(item.at) || undefined}>{formatActivityTime(item.at)}</span>
                    {canDeleteComment && (
                      <IconButton
                        class="activity-comment-delete"
                        size="sm"
                        variant="ghost"
                        icon={<Icon name="trash" size={13} />}
                        aria-label="Delete comment"
                        title="Delete comment"
                        onClick={() => onDeleteComment(item)}
                      />
                    )}
                  </InlineHead>
                  {item.body && (
                    <div class="activity-item-body"><StructuredContent content={item.body} maxHeight={200} mentions={resolvedMentions} /></div>
                  )}
                  {item.attachments?.length > 0 && (
                    <AttachmentChips attachments={item.attachments} disabled class="activity-item-attachments" />
                  )}
                </div>
              </div>
            );
          })}
          {!showOlderActivity && activity.length > 12 && (
            <Button variant="ghost" size="sm" onClick={onShowOlderActivity}>
              Show older ({activity.length - 12})
            </Button>
          )}
        </div>
      ) : (
        <div class="activity-empty">{runningRun ? "No comments or completed runs yet." : "No activity yet."}</div>
      )}
    </Card>
  );
}
