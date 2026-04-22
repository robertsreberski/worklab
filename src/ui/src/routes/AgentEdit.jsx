// src/ui/src/routes/AgentEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

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
  const [saving, setSaving] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

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
    if (!isNew) api.getAgent(name).then(r => setAgent(r.agent)).catch(() => setAgent({ notFound: true }));
  }, [name, isNew]);

  if (!agent) return <div>Loading…</div>;
  if (agent.notFound) return <div>Agent not found. <a href="#/agents">Back</a></div>;

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

  async function save() {
    setSaving(true);
    setError(null);
    try {
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
    } catch (err) {
      setError(err.message || String(err));
    } finally { setSaving(false); }
  }

  async function destroy() {
    if (!confirm(`Delete agent "${name}"?`)) return;
    await api.deleteAgent(name);
    window.location.hash = "#/agents";
  }

  async function consolidateNow() {
    setConsolidating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.consolidateAgent(name);
      setNotice(res.skipped ? "Memory is already current." : `Consolidation started: ${res.runId}`);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setConsolidating(false);
    }
  }

  return (
    <div class="detail">
      <a href="#/agents" class="back-link">← Back</a>
      <h2>{isNew ? "New agent" : agent.display_name}</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}
      {notice && <div class="meta" style="margin-bottom:12px">{notice}</div>}

      <div class="field"><label>Name (slug)</label>
        <input value={agent.name} disabled={!isNew}
          onInput={(e) => setAgent({ ...agent, name: e.target.value })} /></div>
      <div class="field"><label>Display name</label>
        <input value={agent.display_name}
          onInput={(e) => setAgent({ ...agent, display_name: e.target.value })} /></div>
      <div class="field"><label>Description</label>
        <input value={agent.description || ""}
          onInput={(e) => setAgent({ ...agent, description: e.target.value })} /></div>

      <div class="field"><label>Model</label>
        <select value={agent.model} onChange={(e) => setModel(e.target.value)}>
          {modelGroups.map(group => (
            <optgroup key={group.id} label={group.label}>
              {(group.models || []).map(o => (
                <option key={o.value} value={o.value}>{o.label || o.value}</option>
              ))}
            </optgroup>
          ))}
          {!modelGroups.flatMap(g => g.models || []).some(m => m.value === agent.model) && (
            <option value={agent.model}>{agent.model} (unavailable)</option>
          )}
        </select>
        <div class="meta">Stored as an explicit reference: claude:&lt;model&gt;, openai:&lt;model&gt;, or vercel:&lt;providerId&gt;:&lt;model&gt;.</div>
        {modelUnavailable && (
          <div class="status-line warn">This model is not in the enabled runnable model list. It may be disabled, deleted, or not runnable for agent chat.</div>
        )}
      </div>
      <div class="field"><label>Advanced model reference</label>
        <input value={agent.model} onInput={(e) => setModel(e.target.value)} />
      </div>
      <div class="meta" style="margin:-4px 0 12px">
        {selectedModel?.capabilities?.tool_use === false
          ? "This model does not support tool use."
          : `Tools: ${(visibleTools || BUILTIN_TOOLS).join(", ")}`}
        {selectedModel?.capabilities?.reasoning
          ? ` · Reasoning: ${reasoningMode === "toggle" ? "toggle" : (reasoningLevels.join(", "))}`
          : " · Reasoning: unavailable"}
      </div>
      {reasoningMode === "none" ? (
        <div class="field"><label>Effort</label><div class="meta">This model does not support adjustable reasoning.</div></div>
      ) : reasoningMode === "toggle" ? (
        <div class="field"><label>Thinking</label>
          <select value={normalizedEffort === "low" ? "off" : "on"} onChange={(e) => setAgent({ ...agent, effort: e.target.value === "off" ? "low" : "medium" })}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select></div>
      ) : (
        <div class="field"><label>Effort</label>
          <select value={normalizedEffort} onChange={(e) => setAgent({ ...agent, effort: e.target.value })}>
            {reasoningLevels.map(v => <option key={v} value={v}>{v}</option>)}
          </select></div>
      )}

      <div class="field"><label>Instructions (free text — becomes the system prompt role)</label>
        <textarea rows="10" value={agent.instructions}
          onInput={(e) => setAgent({ ...agent, instructions: e.target.value })} /></div>

      <div class="field"><label>Skills allowlist (empty = all enabled skills)</label>
        {skills.length === 0 && <div class="meta">No skills defined yet.</div>}
        <div class="choice-list">
          {skills.map(s => (
          <label key={s.name} class="choice-label">
            <input type="checkbox" checked={agent.skills_allowlist.includes(s.name)}
              onChange={() => setAgent({ ...agent, skills_allowlist: toggleList(agent.skills_allowlist, s.name) })} />
            <span>{s.name}</span>
          </label>
        ))}
        </div>
      </div>

      <div class="field"><label>MCP servers allowlist (empty = all registered, worklab always included)</label>
        {mcpServers.length === 0 && <div class="meta">No user MCP servers registered.</div>}
        <div class="choice-list">
          {mcpServers.map(m => (
          <label key={m} class="choice-label">
            <input type="checkbox" checked={agent.mcp_allowlist.includes(m)}
              onChange={() => setAgent({ ...agent, mcp_allowlist: toggleList(agent.mcp_allowlist, m) })} />
            <span>{m}</span>
          </label>
        ))}
        </div>
      </div>

      <div class="field"><label>Built-in tools allowlist (empty = all tools)</label>
        {!supportsToolUse && <div class="meta">This model cannot call built-in tools.</div>}
        {supportsToolUse && <div class="choice-list">{visibleTools.map(t => (
          <label key={t} class="choice-label">
            <input type="checkbox" checked={agent.builtin_allowlist.includes(t)}
              onChange={() => setAgent({ ...agent, builtin_allowlist: toggleList(agent.builtin_allowlist, t) })} />
            <span>{t}</span>
          </label>
        ))}</div>}
      </div>

      <div class="field">
        <label class="choice-label">
          <input type="checkbox" checked={agent.enabled}
            onChange={(e) => setAgent({ ...agent, enabled: e.target.checked })} />
          <span>Enabled</span>
        </label>
      </div>

      <button class="primary" onClick={save} disabled={saving || !agent.name || !agent.display_name}>
        {saving ? "Saving…" : (isNew ? "Create" : "Save")}
      </button>
      {!isNew && (
        <button onClick={consolidateNow} disabled={consolidating} style="margin-left:8px">
          {consolidating ? "Starting…" : "Consolidate memory"}
        </button>
      )}
      {!isNew && <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>}
    </div>
  );
}
