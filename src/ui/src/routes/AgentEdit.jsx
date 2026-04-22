// src/ui/src/routes/AgentEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const SDK_OPTIONS = [{ value: "claude", label: "Claude" }];
const MODEL_OPTIONS = [
  { value: "haiku", label: "Claude Haiku 4.5" },
  { value: "sonnet", label: "Claude Sonnet 4.6" },
  { value: "opus", label: "Claude Opus 4.7" },
];
const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

const emptyAgent = {
  name: "",
  display_name: "",
  description: "",
  sdk: "claude",
  model: "sonnet",
  effort: "medium",
  instructions: "",
  skills_allowlist: [],
  mcp_allowlist: [],
  builtin_allowlist: [],
  enabled: true,
};

export function AgentEdit({ name }) {
  const isNew = name === "new";
  const [agent, setAgent] = useState(isNew ? emptyAgent : null);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listSkills().then(r => setSkills(r.skills)).catch(() => setSkills([]));
    api.getMcpConfig().then(r => setMcpServers(Object.keys(r.mcpServers || {}))).catch(() => setMcpServers([]));
    if (!isNew) api.getAgent(name).then(r => setAgent(r.agent)).catch(() => setAgent({ notFound: true }));
  }, [name, isNew]);

  if (!agent) return <div>Loading…</div>;
  if (agent.notFound) return <div>Agent not found. <a href="#/agents">Back</a></div>;

  function toggleList(list, value) {
    return list.includes(value) ? list.filter(x => x !== value) : [...list, value];
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await api.createAgent(agent);
        window.location.hash = `#/agents/${agent.name}`;
      } else {
        await api.patchAgent(name, agent);
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

  return (
    <div class="detail">
      <a href="#/agents">← Back</a>
      <h2>{isNew ? "New agent" : agent.display_name}</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}

      <div class="field"><label>Name (slug)</label>
        <input value={agent.name} disabled={!isNew}
          onInput={(e) => setAgent({ ...agent, name: e.target.value })} /></div>
      <div class="field"><label>Display name</label>
        <input value={agent.display_name}
          onInput={(e) => setAgent({ ...agent, display_name: e.target.value })} /></div>
      <div class="field"><label>Description</label>
        <input value={agent.description || ""}
          onInput={(e) => setAgent({ ...agent, description: e.target.value })} /></div>

      <div class="field"><label>SDK</label>
        <select value={agent.sdk} onChange={(e) => setAgent({ ...agent, sdk: e.target.value })}>
          {SDK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></div>
      <div class="field"><label>Model</label>
        <select value={agent.model} onChange={(e) => setAgent({ ...agent, model: e.target.value })}>
          {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></div>
      <div class="field"><label>Effort</label>
        <select value={agent.effort} onChange={(e) => setAgent({ ...agent, effort: e.target.value })}>
          {EFFORT_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
        </select></div>

      <div class="field"><label>Instructions (free text — becomes the system prompt role)</label>
        <textarea rows="10" value={agent.instructions}
          onInput={(e) => setAgent({ ...agent, instructions: e.target.value })} /></div>

      <div class="field"><label>Skills allowlist (empty = all enabled skills)</label>
        {skills.length === 0 && <div class="meta">No skills defined yet.</div>}
        {skills.map(s => (
          <label key={s.name} style="display:inline-block;margin-right:12px">
            <input type="checkbox" checked={agent.skills_allowlist.includes(s.name)}
              onChange={() => setAgent({ ...agent, skills_allowlist: toggleList(agent.skills_allowlist, s.name) })} />
            {s.name}
          </label>
        ))}
      </div>

      <div class="field"><label>MCP servers allowlist (empty = all registered, worklab always included)</label>
        {mcpServers.length === 0 && <div class="meta">No user MCP servers registered.</div>}
        {mcpServers.map(m => (
          <label key={m} style="display:inline-block;margin-right:12px">
            <input type="checkbox" checked={agent.mcp_allowlist.includes(m)}
              onChange={() => setAgent({ ...agent, mcp_allowlist: toggleList(agent.mcp_allowlist, m) })} />
            {m}
          </label>
        ))}
      </div>

      <div class="field"><label>Built-in tools allowlist (empty = all tools)</label>
        {BUILTIN_TOOLS.map(t => (
          <label key={t} style="display:inline-block;margin-right:12px">
            <input type="checkbox" checked={agent.builtin_allowlist.includes(t)}
              onChange={() => setAgent({ ...agent, builtin_allowlist: toggleList(agent.builtin_allowlist, t) })} />
            {t}
          </label>
        ))}
      </div>

      <div class="field"><label>Enabled</label>
        <input type="checkbox" checked={agent.enabled}
          onChange={(e) => setAgent({ ...agent, enabled: e.target.checked })} /></div>

      <button class="primary" onClick={save} disabled={saving || !agent.name || !agent.display_name}>
        {saving ? "Saving…" : (isNew ? "Create" : "Save")}
      </button>
      {!isNew && <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>}
    </div>
  );
}
