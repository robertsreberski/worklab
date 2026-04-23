// src/ui/src/routes/AgentEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { CheckboxField } from "../components/CheckboxField.jsx";
import { SelectField } from "../components/SelectField.jsx";

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

const emptyAgent = {
  name: "",
  display_name: "",
  description: "",
  sdk: "claude",
  model: "claude:claude-sonnet-4-6",
  effort: "medium",
  instructions: "",
  skills_allowlist: [],
  mcp_allowlist: [],
  builtin_allowlist: [],
  enabled: true,
};

function flattenModels(groups = []) {
  return groups.flatMap((group) => (group.models || []).map((model) => ({ ...model, group: group.label })));
}

function getReasoningMode(option) {
  if (!option?.capabilities) return "effort";
  const mode = option.capabilities.reasoning_mode;
  if (mode === "none" || mode === "toggle" || mode === "effort") return mode;
  return option.capabilities.reasoning ? "effort" : "none";
}

function getReasoningLevels(option) {
  if (getReasoningMode(option) !== "effort") return [];
  const explicit = Array.isArray(option?.capabilities?.reasoning_levels)
    ? option.capabilities.reasoning_levels.filter((level) => EFFORT_OPTIONS.includes(level))
    : [];
  return explicit.length ? explicit : EFFORT_OPTIONS;
}

function normalizeEffort(option, effort) {
  const mode = getReasoningMode(option);
  if (mode === "none") return "low";
  if (mode === "toggle") return effort && effort !== "low" ? "medium" : "low";
  const supported = getReasoningLevels(option);
  if (!supported.length) return "low";
  if (!effort) return supported.includes("medium") ? "medium" : supported[0];
  if (supported.includes(effort)) return effort;
  if (effort === "max" && supported.includes("high")) return "high";
  return supported[supported.length - 1];
}

function supportedBuiltinTools(option) {
  if (option?.capabilities?.tool_use === false) return [];
  if (Array.isArray(option?.builtin_tools) && option.builtin_tools.length) return option.builtin_tools;
  return BUILTIN_TOOLS;
}

export function AgentEdit({ name }) {
  const isNew = name === "new";
  const [agent, setAgent] = useState(isNew ? emptyAgent : null);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [consolidating, setConsolidating] = useState(false);
  const [notice, setNotice] = useState(null);
  const [recentRuns, setRecentRuns] = useState(null);

  const allModels = flattenModels(modelGroups);
  const selectedModel = allModels.find((model) => model.value === agent?.model) || null;
  const modelUnavailable = !!agent?.model && modelGroups.length > 0 && !selectedModel;
  const reasoningMode = getReasoningMode(selectedModel);
  const reasoningLevels = getReasoningLevels(selectedModel);
  const normalizedEffort = normalizeEffort(selectedModel, agent?.effort);
  const visibleTools = supportedBuiltinTools(selectedModel);
  const supportsToolUse = visibleTools.length > 0;

  useEffect(() => {
    api.listSkills().then(r => setSkills(r.skills)).catch(() => setSkills([]));
    api.getMcpConfig().then(r => setMcpServers(Object.keys(r.mcpServers || {}))).catch(() => setMcpServers([]));
    api.listAvailableModels().then(r => setModelGroups(r.groups || [])).catch(() => setModelGroups([]));
    if (!isNew) {
      api.getAgent(name).then(r => setAgent(r.agent)).catch(() => setAgent({ notFound: true }));
      api.listAgentRuns(name, 10).then(setRecentRuns).catch(() => setRecentRuns({ runs: [] }));
    }
  }, [name, isNew]);

  if (!agent) return <div>Loading...</div>;
  if (agent.notFound) return <div>Agent not found. <a href="#/agents">Back</a></div>;
  const modelOptions = [
    ...modelGroups.map((group) => ({
      label: group.label,
      options: (group.models || []).map((model) => ({
        value: model.value,
        label: model.label || model.value,
        description: model.description,
      })),
    })),
    ...(allModels.some((model) => model.value === agent.model) ? [] : [{
      label: "Saved value",
      options: [{ value: agent.model, label: `${agent.model} (unavailable)` }],
    }]),
  ];
  const effortOptions = reasoningLevels.map((level) => ({ value: level, label: level }));

  function toggleList(list, value) {
    return list.includes(value) ? list.filter(x => x !== value) : [...list, value];
  }

  function sdkFromModel(model) {
    return String(model || "").split(":", 1)[0] || "claude";
  }

  function setModel(model) {
    const nextOption = allModels.find((item) => item.value === model) || null;
    setAgent({
      ...agent,
      model,
      sdk: sdkFromModel(model),
      effort: normalizeEffort(nextOption, agent.effort),
      builtin_allowlist: nextOption?.capabilities?.tool_use === false
        ? []
        : agent.builtin_allowlist.filter((tool) => supportedBuiltinTools(nextOption).includes(tool)),
    });
  }

  const formSave = useFormSave(async () => {
    const payload = {
      ...agent,
      effort: normalizedEffort,
      builtin_allowlist: supportsToolUse
        ? agent.builtin_allowlist.filter((tool) => visibleTools.includes(tool))
        : [],
    };
    if (isNew) {
      await api.createAgent(payload);
      window.location.hash = `#/agents/${agent.name}`;
    } else {
      await api.patchAgent(name, payload);
    }
  });

  async function destroy() {
    try {
      await api.deleteAgent(name);
      window.location.hash = "#/agents";
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  async function consolidateNow() {
    setConsolidating(true);
    setNotice(null);
    try {
      const res = await api.consolidateAgent(name);
      setNotice(res.skipped ? "Memory is already current." : `Consolidation started: ${res.runId}`);
    } catch (err) {
      pushToast(`Consolidate failed: ${err.message}`, { variant: "error" });
    } finally {
      setConsolidating(false);
    }
  }

  return (
    <div class="detail page-stack">
      <a href="#/agents" class="back-link">Back to agents</a>
      <section class="surface-panel task-hero">
        <div>
          <div class="eyebrow">Agent</div>
          <h2>{isNew ? "New agent" : agent.display_name}</h2>
          <div class="task-meta-grid">
            <span class={agent.enabled ? "status-badge done" : "status-badge muted"}>{agent.enabled ? "Enabled" : "Disabled"}</span>
            <span class="meta-pill">{agent.model}</span>
            <span class="meta-pill">Effort {normalizedEffort}</span>
          </div>
        </div>
        <div class="toolbar">
          <button class="primary" onClick={() => formSave.save().catch(() => {})} disabled={formSave.saving || !agent.name || !agent.display_name}>
            {formSave.saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
          {!isNew && (
            <button onClick={consolidateNow} disabled={consolidating}>
              {consolidating ? "Starting..." : "Consolidate memory"}
            </button>
          )}
          {!isNew && <ConfirmButton class="danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>}
        </div>
      </section>

      {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}
      {notice && <div class="surface-panel compact meta">{notice}</div>}

      <section class="surface-panel">
        <div class="section-kicker">Identity</div>
        <h3 class="section-title">Profile</h3>
        <div class="form-grid">
          <div class="field">
            <label>Name (slug)</label>
            <input value={agent.name} disabled={!isNew}
              onInput={(e) => setAgent({ ...agent, name: e.target.value })} />
          </div>
          <div class="field">
            <label>Display name</label>
            <input value={agent.display_name}
              onInput={(e) => setAgent({ ...agent, display_name: e.target.value })} />
          </div>
          <div class="field span-2">
            <label>Description</label>
            <input value={agent.description || ""}
              onInput={(e) => setAgent({ ...agent, description: e.target.value })} />
          </div>
          <div class="field span-2">
            <CheckboxField checked={agent.enabled} onChange={(e) => setAgent({ ...agent, enabled: e.target.checked })}>
              Enabled
            </CheckboxField>
          </div>
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Runtime</div>
        <h3 class="section-title">Model and reasoning</h3>
        <div class="form-grid">
          <div class="field">
            <label>Model</label>
            <SelectField value={agent.model} options={modelOptions} onChange={setModel} />
            {modelUnavailable && (
              <div class="status-line warn">This model is not in the enabled runnable model list.</div>
            )}
          </div>
          <div class="field">
            {reasoningMode === "none" ? (
              <>
                <label>Effort</label>
                <div class="meta">This model does not support adjustable reasoning.</div>
              </>
            ) : reasoningMode === "toggle" ? (
              <>
                <label>Thinking</label>
                <SelectField
                  value={normalizedEffort === "low" ? "off" : "on"}
                  options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]}
                  onChange={(value) => setAgent({ ...agent, effort: value === "off" ? "low" : "medium" })}
                />
              </>
            ) : (
              <>
                <label>Effort</label>
                <SelectField value={normalizedEffort} options={effortOptions} onChange={(value) => setAgent({ ...agent, effort: value })} />
              </>
            )}
          </div>
          <div class="field span-2">
            <label>Advanced model reference</label>
            <input value={agent.model} onInput={(e) => setModel(e.target.value)} />
            <div class="meta">
              {selectedModel?.capabilities?.tool_use === false
                ? "This model does not support tool use."
                : `Tools: ${(visibleTools || BUILTIN_TOOLS).join(", ")}`}
              {selectedModel?.capabilities?.reasoning
                ? ` / Reasoning: ${reasoningMode === "toggle" ? "toggle" : (reasoningLevels.join(", "))}`
                : " / Reasoning: unavailable"}
            </div>
          </div>
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Behavior</div>
        <h3 class="section-title">Instructions</h3>
        <div class="field">
          <label>System prompt role</label>
          <textarea rows="10" value={agent.instructions}
            onInput={(e) => setAgent({ ...agent, instructions: e.target.value })} />
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Capabilities</div>
        <h3 class="section-title">Allowlists</h3>
        <div class="field">
          <label>Skills allowlist (empty = all enabled skills)</label>
          {skills.length === 0 && <div class="meta">No skills defined yet.</div>}
          <div class="choice-list">
            {skills.map(s => (
              <CheckboxField
                key={s.name}
                checked={agent.skills_allowlist.includes(s.name)}
                onChange={() => setAgent({ ...agent, skills_allowlist: toggleList(agent.skills_allowlist, s.name) })}
              >
                {s.name}
              </CheckboxField>
            ))}
          </div>
        </div>

        <div class="field">
          <label>MCP servers allowlist (empty = all registered, worklab always included)</label>
          {mcpServers.length === 0 && <div class="meta">No user MCP servers registered.</div>}
          <div class="choice-list">
            {mcpServers.map(m => (
              <CheckboxField
                key={m}
                checked={agent.mcp_allowlist.includes(m)}
                onChange={() => setAgent({ ...agent, mcp_allowlist: toggleList(agent.mcp_allowlist, m) })}
              >
                {m}
              </CheckboxField>
            ))}
          </div>
        </div>

        <div class="field">
          <label>Built-in tools allowlist (empty = all tools)</label>
          {!supportsToolUse && <div class="meta">This model cannot call built-in tools.</div>}
          {supportsToolUse && <div class="choice-list">{visibleTools.map(t => (
            <CheckboxField
              key={t}
              checked={agent.builtin_allowlist.includes(t)}
              onChange={() => setAgent({ ...agent, builtin_allowlist: toggleList(agent.builtin_allowlist, t) })}
            >
              {t}
            </CheckboxField>
          ))}</div>}
        </div>
      </section>

      {!isNew && recentRuns && (
        <section class="surface-panel">
          <div class="section-kicker">Activity</div>
          <h3 class="section-title">Recent runs</h3>
          {recentRuns.runs.length === 0 ? (
            <div class="meta">No runs by this agent yet.</div>
          ) : (
            <ul class="usage-list">
              {recentRuns.runs.map((run) => (
                <li key={run.id}>
                  {run.task_id
                    ? <a href={`#/tasks/${run.task_id}?run=${run.id}`}>{run.task_title || run.mode}</a>
                    : <span>{run.mode}</span>}
                  <span class={`status-badge ${run.status === "running" ? "in_progress" : "muted"}`}>{run.status}</span>
                  <span class="meta">
                    {new Date(run.started_at).toLocaleString()}
                    {run.cost_usd != null && ` · $${Number(run.cost_usd).toFixed(4)}`}
                    {run.duration_ms != null && ` · ${run.duration_ms}ms`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
