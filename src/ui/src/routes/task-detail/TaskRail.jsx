import { api } from "../../lib/api.js";
import { pushToast } from "../../lib/toast.js";
import { navigateHash } from "../../lib/navigation.js";
import { taskDisplayKey, taskRouteId } from "../../lib/display.js";
import { Button } from "../../components/primitives/Button.jsx";
import { StatusPill } from "../../components/primitives/StatusPill.jsx";
import { Icon } from "../../components/Icon.jsx";
import { Card } from "../../components/Card.jsx";
import { EntityBadge } from "../../components/EntityBadge.jsx";
import { ActionDock, SectionGroup, SectionStack } from "../../components/layout/index.js";
import { DEFAULT_RUN_POLICY } from "./format.js";
import { RunArtifactsSection } from "./RunCards.jsx";
import {
  AgentRailRow,
  TaskContextList,
} from "./WorkflowCards.jsx";

function dependencyContextLabel(dependency) {
  const latest = dependency?.latest_execute_run;
  const artifacts = dependency?.artifact_summary || {};
  const parts = [];
  if (latest?.summary) {
    parts.push(latest.summary);
  } else if (latest?.id) {
    parts.push(`Latest execute ${latest.status || latest.process_status || "recorded"}`);
  } else if ((dependency?.stage || "plan") === "done") {
    parts.push("No execute run recorded");
  }
  const files = Number(artifacts.files || 0);
  if (files > 0) {
    const added = Number(artifacts.added_lines || 0);
    const removed = Number(artifacts.removed_lines || 0);
    const delta = added || removed ? `, +${added} -${removed}` : "";
    parts.push(`${files} file${files === 1 ? "" : "s"}${delta}`);
  }
  return parts.join(" - ");
}

function DependencyLink({ dependency }) {
  const context = dependencyContextLabel(dependency);
  return (
    <a key={dependency.id} class="blocked-link dependency-link" href={`#/tasks/${taskRouteId(dependency)}`}>
      <span class="dependency-link-copy">
        <EntityBadge kind="task" label={dependency.title} />
        {context && <span class="dependency-link-meta">{context}</span>}
      </span>
      <StatusPill status={dependency.stage || "plan"} size="sm" />
    </a>
  );
}

export function TaskRail({
  task,
  agents,
  hasRailDependencies,
  runningRun,
  runningRunStream,
  onAssigneeChange,
  onDelete,
  readOnly = false,
}) {
  if (!task) return null;
  return (
    <div class="task-detail-rail-content">
      {readOnly ? (
        <Card variant="spacious" kicker="Goal" title="Lead cycle anchor" class="rail-agents-card">
          <p class="muted">This task is managed by the project goal. Use the Goal page for outcome changes and lead-cycle reviews.</p>
        </Card>
      ) : (
        <Card variant="spacious" kicker="Assignment" title="Roles" class="rail-agents-card">
          <SectionStack class="rail-agents-stack">
            <AgentRailRow role="owner" value={task.owner_agent || ""} onChange={(value) => onAssigneeChange("owner_agent", value)} agents={agents} caption={task.owner_agent ? "Runs work" : undefined} />
            <AgentRailRow role="planner" value={task.planner_agent || ""} onChange={(value) => onAssigneeChange("planner_agent", value)} agents={agents} />
            <AgentRailRow role="reviewer" value={task.reviewer_agent || ""} onChange={(value) => onAssigneeChange("reviewer_agent", value)} agents={agents} />
          </SectionStack>
        </Card>
      )}

      <Card variant="spacious" kicker="Context" title="Metadata" class="task-metadata-card task-context-card">
        <TaskContextList task={task} />
        {hasRailDependencies && (
          <SectionGroup as="div" class="task-dependencies-section" label={<span class="all-caps">Dependencies</span>}>
            {(task.blocked_by || []).length > 0 && (
              <SectionGroup as="div" class="dependency-group" label={<span class="all-caps">Blocked by</span>} count={(task.blocked_by || []).length}>
                {(task.blocked_by || []).map((dependency) => <DependencyLink key={dependency.id} dependency={dependency} />)}
              </SectionGroup>
            )}
            {(task.blocks || []).length > 0 && (
              <SectionGroup as="div" class="dependency-group" label={<span class="all-caps">Blocks</span>} count={(task.blocks || []).length}>
                {(task.blocks || []).map((dependency) => <DependencyLink key={dependency.id} dependency={dependency} />)}
              </SectionGroup>
            )}
          </SectionGroup>
        )}
        <RunArtifactsSection task={task} runningRun={runningRun} streamState={runningRunStream} />
      </Card>

      {!readOnly && (
        <Card variant="spacious" kicker="Actions" title="Maintenance" class="task-maintenance-card">
          <ActionDock
            class="task-actions-stack"
            secondary={(
              <Button
                variant="secondary"
                iconLeft={<Icon name="database" size={13} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(taskDisplayKey(task));
                    pushToast("Task key copied", { variant: "success" });
                  } catch {
                    pushToast("Copy failed", { variant: "error" });
                  }
                }}
              >
                Copy task key
              </Button>
            )}
            overflow={(
              <Button
                variant="secondary"
                iconLeft={<Icon name="copy" size={13} />}
                onClick={async () => {
                  try {
                    const copy = {
                      title: `Copy of ${task.title}`,
                      instructions: task.instructions,
                      owner_agent: task.owner_agent,
                      planner_agent: task.planner_agent,
                      reviewer_agent: task.reviewer_agent,
                      run_policy: task.run_policy || DEFAULT_RUN_POLICY,
                      project_id: task.project_id || null,
                      tags: task.tags,
                    };
                    const r = await api.createTask(copy);
                    pushToast("Task duplicated", { variant: "success" });
                    navigateHash(`#/tasks/${taskRouteId(r.task)}`);
                  } catch (err) { pushToast(`Duplicate failed: ${err.message}`, { variant: "error" }); }
                }}
              >
                Duplicate
              </Button>
            )}
            primary={(
              <Button variant="destructive" iconLeft={<Icon name="trash" size={13} />} onClick={onDelete}>
                Delete task
              </Button>
            )}
          />
        </Card>
      )}
    </div>
  );
}
