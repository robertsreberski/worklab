import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const taskDetailSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx"),
  "utf8",
);
const taskActivitySource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/routes/task-detail/TaskActivitySection.jsx"),
  "utf8",
);

describe("TaskDetail team metadata", () => {
  it("renders the resolved team display name instead of the raw canonical id", () => {
    expect(taskDetailSource).toContain("taskTeamDisplay");
    expect(taskDetailSource).toContain("task?.team?.name");
    expect(taskDetailSource).not.toContain('label={task.team_id}');
  });
});

describe("TaskDetail comment author metadata", () => {
  it("renders agent comment authors as plain names instead of badges", () => {
    expect(taskActivitySource).toContain('class="activity-author-name agent"');
    expect(taskActivitySource).toContain("badge={false}");
    expect(taskDetailSource).not.toContain('<AgentLink name={agentName} label={commentAuthorLabel(item)} agents={agents} />');
  });
});
