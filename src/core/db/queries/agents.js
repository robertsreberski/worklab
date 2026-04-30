// agents-table queries.

export function getAgentByName(db, name) {
  return db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
}

export function getEnabledAgentByName(db, name) {
  return db.prepare("SELECT * FROM agents WHERE name = ? AND enabled = 1").get(name);
}

export function agentExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM agents WHERE name = ?").get(name));
}

export function enabledAgentExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM agents WHERE name = ? AND enabled = 1").get(name));
}

export function listEnabledAgentNames(db) {
  return db.prepare("SELECT name FROM agents WHERE enabled = 1 ORDER BY name").all().map((row) => row.name);
}

export function getAgentBudget(db, name) {
  return db
    .prepare("SELECT daily_budget_usd, per_run_budget_usd FROM agents WHERE name = ?")
    .get(name);
}

export function getAgentPerRunBudget(db, name) {
  return db.prepare("SELECT per_run_budget_usd FROM agents WHERE name = ?").get(name);
}

export function getAgentSelfReviewFlag(db, name) {
  return db.prepare("SELECT allow_self_review FROM agents WHERE name = ?").get(name);
}
