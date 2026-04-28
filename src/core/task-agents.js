export function runnableStageForAgent(stage) {
  return stage === "done" ? "execute" : stage;
}

export function agentForTaskStage(task, stage) {
  const runnableStage = runnableStageForAgent(stage);
  if (runnableStage === "review") return task?.reviewer_agent || null;
  if (runnableStage === "plan") return task?.planner_agent || task?.owner_agent || null;
  return task?.owner_agent || null;
}

export function missingAgentMessageForTaskStage(stage) {
  const runnableStage = runnableStageForAgent(stage);
  if (runnableStage === "review") return "no reviewer assigned";
  if (runnableStage === "plan") return "no planner or owner assigned";
  return "no owner assigned";
}
