// §6.5 AgentEdit — form for one agent. Inline two-pane detail.
// Model selector uses unified Select (§3.6). Reasoning effort: RadioGroup when
// 3–5 options, Select otherwise. If `reasoningMode === 'none'`, renders muted
// placeholder (§6.5 rule).

import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { Checkbox } from "../components/primitives/Checkbox.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { RadioGroup } from "../components/primitives/RadioGroup.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { useUnsavedChangesGuard } from "../lib/navigation.js";

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
  const [baseline, setBaseline] = useState(null);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [consolidating, setConsolidating] = useState(false);
  const [notice, setNotice] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

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
      api.getAgent(name).then(r => { setAgent(r.agent); setBaseline(r.agent); }).catch(() => setAgent({ notFound: true }));
    } else {
      setAgent(emptyAgent);
      setBaseline(emptyAgent);
    }
  }, [name, isNew]);

  const isDirty = useMemo(() => baseline ? JSON.stringify(agent) !== JSON.stringify(baseline) : true, [agent, baseline]);
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });

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
      pushToast("Agent created", { variant: "success" });
      setBaseline(agent);
      onSaved?.(res.agent.name);
    } else {
      await api.patchAgent(name, payload);
      pushToast("Saved.", { variant: "success" });
      setBaseline(agent);
      onSaved?.(name);
    }
  });

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
  });

  if (!agent) return <LoadingState caption="Loading agent…" />;
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
  const useRadioForEffort = reasoningMode === "effort" && reasoningLevels.length >= 3 && reasoningLevels.length <= 5;

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
      pushToast("Agent deleted", { variant: "success" });
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
        <div class="pane-detail-head-copy">
          {!isNew && <AgentAvatar name={agent.name} label={agent.display_name || agent.name} size={36} />}
          <div class="pane-detail-head-titles">
            <div class="all-caps">{isNew ? "Create agent" : "Agent"}</div>
            <h2>{title}</h2>
          </div>
        </div>
        <div class="toolbar">
          <StatusPill status={agent.enabled ? "enabled" : "disabled"} />
          {!isNew && (
            <Button variant="ghost" iconLeft={<Icon name="refresh-cw" size={13} />} onClick={consolidateNow} loading={consolidating}>
              Consolidate
            </Button>
          )}
          {!isNew && (
            <Button variant="destructive" onClick={() => setDeleteOpen(true)} iconLeft={<Icon name="trash" size={13} />}>Delete</Button>
          )}
          <Button
            variant={isDirty || isNew ? "primary" : "secondary"}
            onClick={() => formSave.save().catch(() => {})}
            loading={formSave.saving}
            disabled={!agent.display_name}
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      </header>
      <div class="pane-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}
        {notice && <Banner variant="info" detail={notice} />}

        <FormSection kicker="Identity" title="Profile">
          <FormGrid columns={2}>
            <FormField label="Display name" required>
              <Input value={agent.display_name} onInput={(e) => setAgent({ ...agent, display_name: e.target.value })} />
            </FormField>
            <FormField switchInside>
              <Switch
                checked={agent.enabled}
                onChange={(next) => setAgent({ ...agent, enabled: next })}
                label="Available for assignment"
                description="Unavailable agents stay configured but cannot be selected."
              />
            </FormField>
            <FormField label="Description" class="span-2">
              <Input value={agent.description || ""} onInput={(e) => setAgent({ ...agent, description: e.target.value })} />
            </FormField>
          </FormGrid>
          <AdvancedMeta items={[{ label: "Slug", value: isNew ? "Generated after create" : agent.name }]} />
        </FormSection>

        <FormSection kicker="Runtime" title="Model & reasoning">
          <FormGrid columns={2}>
            <FormField label="Model" required>
              <Select value={agent.model} options={modelOptions} onChange={setModel} searchable />
            </FormField>
            <FormField label="Advanced reference" hint="Saved model value used at runtime.">
              <Input value={agent.model} readOnly class="mono-input" />
            </FormField>
            <FormField
              label={reasoningMode === "toggle" ? "Thinking" : "Effort"}
              class="span-2"
              hint={reasoningMode === "none" ? "This model does not support reasoning effort" : undefined}
            >
              {reasoningMode === "none" ? (
                <span class="form-field-empty-hint">This model does not support adjustable reasoning.</span>
              ) : reasoningMode === "toggle" ? (
                <RadioGroup
                  ariaLabel="Thinking"
                  value={normalizedEffort === "low" ? "off" : "on"}
                  onChange={(v) => setAgent({ ...agent, effort: v === "off" ? "low" : "medium" })}
                  options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]}
                />
              ) : useRadioForEffort ? (
                <RadioGroup
                  ariaLabel="Reasoning effort"
                  value={normalizedEffort}
                  onChange={(v) => setAgent({ ...agent, effort: v })}
                  options={effortOptions}
                />
              ) : (
                <Select
                  value={normalizedEffort}
                  options={effortOptions}
                  onChange={(v) => setAgent({ ...agent, effort: v })}
                />
              )}
            </FormField>
          </FormGrid>
          <div class="field-hint field-hint-spaced">
            {selectedModel?.capabilities?.tool_use === false
              ? "This model does not support tool use."
              : `Tools: ${(visibleTools || BUILTIN_TOOLS).join(", ")}`}
            {selectedModel?.capabilities?.reasoning
              ? ` · Reasoning: ${reasoningMode === "toggle" ? "toggle" : reasoningLevels.join(", ")}`
              : " · Reasoning: unavailable"}
          </div>
        </FormSection>

        <FormSection kicker="Behavior" title="Instructions">
          <FormField label="System prompt role">
            <Textarea
              rows={10}
              monospace
              autoGrow
              value={agent.instructions}
              onInput={(e) => setAgent({ ...agent, instructions: e.target.value })}
            />
          </FormField>
        </FormSection>

        <FormSection kicker="Capabilities" title="Allowlists">
          <FormField label="Skills" hint="Empty = all enabled.">
            {skills.length === 0 ? (
              <div class="field-hint">No skills defined yet.</div>
            ) : (
              <div class="checkbox-stack">
                {skills.map((s) => (
                  <Checkbox
                    key={s.name}
                    checked={agent.skills_allowlist.includes(s.name)}
                    onChange={() => setAgent({ ...agent, skills_allowlist: toggleList(agent.skills_allowlist, s.name) })}
                    label={s.display_name || s.name}
                  />
                ))}
              </div>
            )}
          </FormField>
          <FormField label="MCP servers" hint="Empty = all registered.">
            {mcpServers.length === 0 ? (
              <div class="field-hint">No user MCP servers registered.</div>
            ) : (
              <div class="checkbox-stack">
                {mcpServers.map((m) => (
                  <Checkbox
                    key={m}
                    checked={agent.mcp_allowlist.includes(m)}
                    onChange={() => setAgent({ ...agent, mcp_allowlist: toggleList(agent.mcp_allowlist, m) })}
                    label={m}
                  />
                ))}
              </div>
            )}
          </FormField>
          <FormField label="Built-in tools" hint={supportsToolUse ? "Empty = all." : "This model cannot call built-in tools."}>
            {supportsToolUse && (
              <div class="checkbox-stack">
                {visibleTools.map((t) => (
                  <Checkbox
                    key={t}
                    checked={agent.builtin_allowlist.includes(t)}
                    onChange={() => setAgent({ ...agent, builtin_allowlist: toggleList(agent.builtin_allowlist, t) })}
                    label={t}
                  />
                ))}
              </div>
            )}
          </FormField>
        </FormSection>
      </div>

      {/* Delete modal */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete "${agent.display_name || agent.name}"?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        }
      >
        <p>This removes the agent. Tasks currently assigned to it will keep the reference but won't be runnable until reassigned.</p>
      </Modal>

      <Modal
        open={guard.promptOpen}
        onClose={guard.keepEditing}
        title="You have unsaved changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={guard.keepEditing}>Keep editing</Button>
            <Button variant="destructive" onClick={guard.discardAndLeave}>Discard</Button>
            <Button variant="primary" loading={formSave.saving} onClick={() => guard.saveAndLeave().catch(() => {})}>
              Save & leave
            </Button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    </>
  );
}
