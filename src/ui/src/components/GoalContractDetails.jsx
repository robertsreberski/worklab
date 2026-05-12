function latestGoalCheckpoint(goal = {}) {
  const notes = Array.isArray(goal?.contract?.checkpoint_notes) ? goal.contract.checkpoint_notes : [];
  return notes[notes.length - 1] || null;
}

export function GoalContractDetails({ goal }) {
  const contract = goal?.contract || {};
  const checkpoint = latestGoalCheckpoint(goal);
  return (
    <div class="team-goal-contract">
      <div>
        <span>North star</span>
        <strong>{contract.north_star || "(not set)"}</strong>
      </div>
      <div>
        <span>Objective</span>
        <strong>{contract.objective || "(not set)"}</strong>
      </div>
      <div>
        <span>Done when</span>
        <strong>{contract.stopping_condition || "(not set)"}</strong>
      </div>
      <div>
        <span>Validate with</span>
        <strong>{contract.validation_loop || "(not set)"}</strong>
      </div>
      {contract.constraints?.length ? (
        <div>
          <span>Constraints</span>
          <strong>{contract.constraints.join(", ")}</strong>
        </div>
      ) : null}
      {checkpoint ? (
        <div>
          <span>Latest checkpoint</span>
          <strong>{checkpoint.checkpoint_note || checkpoint.validation_summary || "(empty checkpoint)"}</strong>
        </div>
      ) : null}
      {goal?.goal_status_reason ? (
        <div>
          <span>Status reason</span>
          <strong>{goal.goal_status_reason}</strong>
        </div>
      ) : null}
    </div>
  );
}
