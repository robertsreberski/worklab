import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { CheckboxField } from "../components/CheckboxField.jsx";
import { SelectField } from "../components/SelectField.jsx";
import { SwitchField } from "../components/SwitchField.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { modelDisplayName } from "../lib/display.js";

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

export function AgentEdit({ name, onSaved, onDeleted }) {
  const isNew = name === "new";
  const [agent, setAgent] = useState(isNew ? emptyAgent : null);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [consolidating, setConsolidating] = useState(false);
  const [notice, setNotice] = useState(null);

  const allModels = flattenModels(modelGroups);
  const selectedModel = allModels.find((m) => m.value === agent?.model) || null;
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
    } else {
      setAgent(emptyAgent);
    }
  }, [name, isNew]);

  const formSave = useFormSave(async () => {
    const payload = {
      ...agent,
      name: isNew ? undefined : agent.name,
      effort: normalizedEffort,
      builtin_allowlist: supportsToolUse
        ? agent.builtin_allowlist.filter((t) => visibleTools.includes(t))
        : [],
    };
    if (isNew) {
      const res = await api.createAgent(payload);
      onSaved?.(res.agent.name);
    } else {
      await api.patchAgent(name, payload);
      onSaved?.(name);
    }
  });

  if (!agent) return <div class="pane-empty">Loading agent...</div>;
  if (agent.notFound) return (
    <div class="pane-empty">
      <h3>Agent not found</h3>
      <p>This agent may have been deleted.</p>
    </div>
  );

  const modelOptions = [
    ...modelGroups.map((group) => ({
      label: group.available === false ? `${group.label} (credentials not set)` : group.label,
      options: (group.models || []).map((m) => ({ value: m.value, label: m.label || m.value })),
    })),
    ...(allModels.some((m) => m.value === agent.model) ? [] : [{
      label: "Saved value",
      options: [{ value: agent.model, label: `${agent.model} (unavailable)` }],
    }]),
  ];
  const effortOptions = reasoningLevels.map((level) => ({ value: level, label: level }));

  function toggleList(list, value) {
    return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  }

  function setModel(model) {
    const opt = allModels.find((item) => item.value === model) || null;
    setAgent({
      ...agent,
      model,
      sdk: String(model || "").split(":", 1)[0] || "claude",
      effort: normalizeEffort(opt, agent.effort),
      builtin_allowlist: opt?.capabilities?.tool_use === false
        ? []
        : agent.builtin_allowlist.filter((t) => supportedBuiltinTools(opt).includes(t)),
    });
  }

  async function destroy() {
    try {
      await api.deleteAgent(name);
      onDeleted?.();
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

  const title = isNew ? "New agent" : (agent.display_name || agent.name);

  return (
    <>
      <header class="pane-detail-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          {!isNew && <AgentAvatar name={agent.name} label={agent.display_name || agent.name} size={36} />}
          <div style={{ minWidth: 0 }}>
            <div class="eyebrow">{isNew ? "Create agent" : "Agent"}</div>
            <h2>{title}</h2>
          </div>
        </div>
        <div class="toolbar">
          <StatusPill status={agent.enabled ? "enabled" : "disabled"} />
          {!isNew && (
            <button class="button ghost" onClick={consolidateNow} disabled={consolidating}>
              <Icon name="refresh-cw" size={13} />
              {consolidating ? "Starting..." : "Consolidate"}
            </button>
          )}
          {!isNew && <ConfirmButton class="button danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>}
          <button
            class="button primary"
            onClick={() => formSave.save().catch(() => {})}
            disabled={formSave.saving || !agent.display_name}
          >
            {formSave.saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
        </div>
      </header>
      <div class="pane-detail-body">
        {formSave.error && <div class="form-error">Save failed: {formSave.error}</div>}
        {notice && <div class="surface-panel compact" style={{ color: "var(--muted)" }}>{notice}</div>}

        <section class="surface-panel">
          <div class="section-kicker">Identity</div>
          <h3>Profile</h3>
          <div class="form-grid">
            <div class="field">
              <label class="field-label">Display name</label>
              <input
                class="form-input"
                value={agent.display_name}
                onInput={(e) => setAgent({ ...agent, display_name: e.target.value })}
              />
            </div>
            <div class="field">
              <SwitchField
                checked={agent.enabled}
                onChange={(e) => setAgent({ ...agent, enabled: e.target.checked })}
                description="Unavailable agents stay configured but cannot be selected."
              >
                Available for assignment
              </SwitchField>
            </div>
            <div class="field span-2">
              <label class="field-label">Description</label>
              <input
                class="form-input"
                value={agent.description || ""}
                onInput={(e) => setAgent({ ...agent, description: e.target.value })}
              />
            </div>
          </div>
          <AdvancedMeta items={[{ label: "Slug", value: isNew ? "Generated after create" : agent.name }]} />
        </section>

        <section class="surface-panel">
          <div class="section-kicker">Runtime</div>
          <h3>Model & reasoning</h3>
          <div class="form-grid">
            <div class="field">
              <label class="field-label">Model</label>
              <SelectField value={agent.model} options={modelOptions} onChange={setModel} />
            </div>
            <div class="field">
              <label class="field-label">Advanced reference</label>
              <input class="form-input mono-input" value={agent.model} readOnly />
            </div>
            <div class="field">
              {reasoningMode === "none" ? (
                <>
                  <label class="field-label">Effort</label>
                  <div class="field-hint">This model does not support adjustable reasoning.</div>
                </>
              ) : reasoningMode === "toggle" ? (
                <>
                  <label class="field-label">Thinking</label>
                  <SelectField
                    value={normalizedEffort === "low" ? "off" : "on"}
                    options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]}
                    onChange={(v) => setAgent({ ...agent, effort: v === "off" ? "low" : "medium" })}
                  />
                </>
              ) : (
                <>
                  <label class="field-label">Effort</label>
                  <SelectField
                    value={normalizedEffort}
                    options={effortOptions}
                    onChange={(v) => setAgent({ ...agent, effort: v })}
                  />
                </>
              )}
            </div>
            <div class="field span-2">
              <div class="field-hint">
                {selectedModel?.capabilities?.tool_use === false
                  ? "This model does not support tool use."
                  : `Tools: ${(visibleTools || BUILTIN_TOOLS).join(", ")}`}
                {selectedModel?.capabilities?.reasoning
                  ? ` · Reasoning: ${reasoningMode === "toggle" ? "toggle" : reasoningLevels.join(", ")}`
                  : " · Reasoning: unavailable"}
              </div>
            </div>
          </div>
        </section>

        <section class="surface-panel">
          <div class="section-kicker">Behavior</div>
          <h3>Instructions</h3>
          <div class="field">
            <label class="field-label">System prompt role</label>
            <textarea
              class="form-input mono-input"
              rows="10"
              value={agent.instructions}
              onInput={(e) => setAgent({ ...agent, instructions: e.target.value })}
            />
          </div>
        </section>

        <section class="surface-panel">
          <div class="section-kicker">Capabilities</div>
          <h3>Allowlists</h3>
          <div class="field">
            <label class="field-label">Skills (empty = all enabled)</label>
            {skills.length === 0 && <div class="field-hint">No skills defined yet.</div>}
            {skills.map((s) => (
              <CheckboxField
                key={s.name}
                checked={agent.skills_allowlist.includes(s.name)}
                onChange={() => setAgent({ ...agent, skills_allowlist: toggleList(agent.skills_allowlist, s.name) })}
              >
                {s.display_name || s.name}
              </CheckboxField>
            ))}
          </div>
          <div class="field">
            <label class="field-label">MCP servers (empty = all registered)</label>
            {mcpServers.length === 0 && <div class="field-hint">No user MCP servers registered.</div>}
            {mcpServers.map((m) => (
              <CheckboxField
                key={m}
                checked={agent.mcp_allowlist.includes(m)}
                onChange={() => setAgent({ ...agent, mcp_allowlist: toggleList(agent.mcp_allowlist, m) })}
              >
                {m}
              </CheckboxField>
            ))}
          </div>
          <div class="field">
            <label class="field-label">Built-in tools (empty = all)</label>
            {!supportsToolUse && <div class="field-hint">This model cannot call built-in tools.</div>}
            {supportsToolUse && visibleTools.map((t) => (
              <CheckboxField
                key={t}
                checked={agent.builtin_allowlist.includes(t)}
                onChange={() => setAgent({ ...agent, builtin_allowlist: toggleList(agent.builtin_allowlist, t) })}
              >
                {t}
              </CheckboxField>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
