// Decision vocabulary used by the worklab_result contract. The task workflow
// (src/core/state-machine.js) imports these constants too — the contract
// owns the source of truth so providers and the domain agree on the same
// vocabulary.

export const STAGES = [
  "plan",
  "execute",
  "review",
  "awaiting_children",
  "awaiting_user",
  "blocked",
  "done",
];

export const DECISIONS = [
  "advance",
  "approve",
  "reject",
  "block",
  "pause",
  "delegate",
];
