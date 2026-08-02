const PROFILE_SELECT = `
  SELECT
    p.*,
    a.display_name AS agent_display_name,
    a.description AS agent_description,
    a.sdk AS agent_sdk,
    a.model AS agent_model,
    a.execution_mode AS agent_execution_mode,
    a.enabled AS agent_enabled
  FROM acp_profiles p
  JOIN agents a ON a.name = p.agent_name
`;

export function listAcpProfiles(db) {
  return db.prepare(`${PROFILE_SELECT} ORDER BY p.updated_at DESC, p.rowid DESC`).all();
}

export function getAcpProfileById(db, id) {
  return db.prepare(`${PROFILE_SELECT} WHERE p.id = ?`).get(id);
}

export function getAcpProfileByAgentName(db, agentName) {
  return db.prepare(`${PROFILE_SELECT} WHERE p.agent_name = ?`).get(agentName);
}

export function getAcpProfileByMonoSourceId(db, sourceId) {
  return db.prepare(`${PROFILE_SELECT} WHERE p.mono_source_id = ?`).get(sourceId);
}

export function insertAcpProfile(db, profile) {
  db.prepare(`
    INSERT INTO acp_profiles (
      id, agent_name, driver, command, args_json, cwd, env_keys_json,
      mono_source_id, mono_source_json, configuration_owner, workspace_owner,
      mcp_owner, canonical_workspace, permissions_policy_json,
      config_policy_json, session_policy_json, probe_timeout_ms,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.id,
    profile.agentName,
    profile.driver,
    profile.command,
    profile.argsJson,
    profile.cwd,
    profile.envKeysJson,
    profile.monoSourceId,
    profile.monoSourceJson,
    profile.configurationOwner,
    profile.workspaceOwner,
    profile.mcpOwner,
    profile.canonicalWorkspace,
    profile.permissionsPolicyJson,
    profile.configPolicyJson,
    profile.sessionPolicyJson,
    profile.probeTimeoutMs,
    profile.createdAt,
    profile.updatedAt,
  );
}

export function updateAcpProfile(db, profile) {
  return db.prepare(`
    UPDATE acp_profiles
    SET command = ?, args_json = ?, cwd = ?, env_keys_json = ?,
        configuration_owner = ?, workspace_owner = ?, mcp_owner = ?,
        canonical_workspace = ?, permissions_policy_json = ?,
        config_policy_json = ?, session_policy_json = ?, probe_timeout_ms = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    profile.command,
    profile.argsJson,
    profile.cwd,
    profile.envKeysJson,
    profile.configurationOwner,
    profile.workspaceOwner,
    profile.mcpOwner,
    profile.canonicalWorkspace,
    profile.permissionsPolicyJson,
    profile.configPolicyJson,
    profile.sessionPolicyJson,
    profile.probeTimeoutMs,
    profile.updatedAt,
    profile.id,
  );
}

export function updateAcpProfileProbe(db, id, {
  state,
  probedAt,
  resultJson = "{}",
  errorJson = "{}",
}) {
  return db.prepare(`
    UPDATE acp_profiles
    SET last_probe_state = ?, last_probe_at = ?, last_probe_result_json = ?,
        last_probe_error_json = ?, updated_at = MAX(updated_at, ?)
    WHERE id = ?
  `).run(state, probedAt, resultJson, errorJson, probedAt, id);
}

export function deleteAcpProfileById(db, id) {
  return db.prepare("DELETE FROM acp_profiles WHERE id = ?").run(id);
}

export function countAcpAgentReferences(db, agentName) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tasks
        WHERE delegated_to_agent = ? OR owner_agent = ? OR planner_agent = ?
          OR reviewer_agent = ? OR plan_updated_by = ?) AS task_count,
      (SELECT COUNT(*) FROM task_runs WHERE agent_name = ?) AS run_count,
      (SELECT COUNT(*) FROM teams WHERE lead_agent = ?) AS team_count,
      (SELECT COUNT(*) FROM team_members WHERE agent_name = ?) AS membership_count,
      (SELECT COUNT(*) FROM automations WHERE agent_name = ?) AS automation_count,
      (SELECT COUNT(*) FROM agent_memories WHERE agent_name = ?) AS memory_count,
      (SELECT COUNT(*) FROM agent_consolidations WHERE agent_name = ?) AS consolidation_count
  `).get(
    agentName, agentName, agentName, agentName, agentName,
    agentName, agentName, agentName, agentName, agentName, agentName,
  );
  const counts = Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, Number(value) || 0]),
  );
  return {
    ...counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
  };
}
