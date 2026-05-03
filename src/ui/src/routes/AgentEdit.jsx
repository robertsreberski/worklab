// §6.5 AgentEdit — form for one agent. Inline two-pane detail.
// Model selector uses unified Select (§3.6). Reasoning effort: RadioGroup when
// 3–5 options, Select otherwise. If `reasoningMode === 'none'`, renders muted
// placeholder (§6.5 rule).

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { Select } from "../components/primitives/Select.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { RadioGroup } from "../components/primitives/RadioGroup.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { MobilePillRow, MobileTopbar, useAppChrome } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { modelDisplayName, modelOptionDescription } from "../lib/display.js";
import { useUnsavedChangesGuard } from "../lib/navigation.js";
import { useAppResume } from "../lib/pageVisibility.js";

const EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"];
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];
const BUILTIN_TOOL_DESCRIPTIONS = {
  Read: "Read a local file with line numbers.",
  Write: "Write content to a local file.",
  Edit: "Replace an exact string in a local file.",
  Glob: "Find files matching a pattern.",
  Grep: "Search file contents with grep.",
  Bash: "Execute a shell command in the workspace.",
  WebFetch: "Fetch a URL and return text.",
  WebSearch: "Search the web and return result summaries.",
};

const AGENT_EDIT_SECTIONS = [
  { id: "agent-edit-identity", num: "01", label: "Identity", meta: "Profile" },
  { id: "agent-edit-runtime", num: "02", label: "Runtime", meta: "Model" },
  { id: "agent-edit-policy", num: "03", label: "Policy", meta: "Review" },
  { id: "agent-edit-behavior", num: "04", label: "Behavior", meta: "Prompt" },
  { id: "agent-edit-capabilities", num: "05", label: "Capabilities", meta: "Scope" },
];

const emptyAgent = {
  name: "",
  display_name: "",
  description: "",
  sdk: "claude",
  model: "claude:claude-sonnet-4-6",
  effort: "medium",
  instructions: "",
  skills_allowlist: [],
  skills_allowlist_mode: "all",
  mcp_allowlist: [],
  mcp_allowlist_mode: "all",
  builtin_allowlist: [],
  builtin_allowlist_mode: "all",
  allow_self_review: true,
  browser_tools_review_only: false,
  daily_budget_usd: null,
  per_run_budget_usd: null,
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
  if (mode === "toggle") return effort && effort !== "none" && effort !== "low" ? "medium" : "low";
  const supported = getReasoningLevels(option);
  if (!supported.length) return "low";
  if (!effort) return supported.includes("medium") ? "medium" : supported[0];
  if (supported.includes(effort)) return effort;
  if (effort === "max" && supported.includes("xhigh")) return "xhigh";
  if (effort === "max" && supported.includes("high")) return "high";
  if (effort === "none" && supported.includes("low")) return "low";
  return supported[supported.length - 1];
}
function supportedBuiltinTools(option) {
  if (option?.capabilities?.tool_use === false) return [];
  if (Array.isArray(option?.builtin_tools)) return option.builtin_tools;
  return BUILTIN_TOOLS;
}

function modelGroupLabel(group) {
  if (group.available !== false) return group.label;
  return `${group.label} (unavailable)`;
}

function optionUnavailable(option) {
  return !option || option.disabled === true || option.available === false;
}

function normalizedNames(list) {
  return Array.isArray(list) ? list.filter((name) => typeof name === "string" && name.trim()) : [];
}

function allowlistMode(mode) {
  return mode === "custom" ? "custom" : "all";
}

function budgetInputValue(value) {
  return value == null ? "" : String(value);
}

function parseBudgetInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : value;
}

function EntityChromeBridge({ chrome }) {
  useAppChrome(chrome, [chrome]);
  return null;
}

export function memoryFreshnessLabel(memory) {
  switch (memory?.freshness) {
    case "current":
      return "Current";
    case "stale":
      return "Needs consolidation";
    case "not_consolidated":
      return memory?.exists ? "Needs consolidation" : "No memory yet";
    case "no_journal":
      return "No journal yet";
    case "consolidating":
      return "Consolidating";
    default:
      return "Loading";
  }
}

export function memoryFreshnessStatus(memory) {
  switch (memory?.freshness) {
    case "current":
      return "complete";
    case "stale":
    case "not_consolidated":
      return "review";
    case "consolidating":
      return "running";
    case "no_journal":
    default:
      return "disabled";
  }
}

export function formatMemoryBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMemoryTime(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function memoryMetaItems(memory) {
  if (!memory) return [{ label: "State", value: "Loading" }];
  const journalValue = !memory.journal_exists
    ? "No journal"
    : memory.journal_changed
      ? "Changed"
      : "Matched";
  return [
    { label: "State", value: memoryFreshnessLabel(memory), mono: false },
    { label: "Memory", value: memory.exists ? formatMemoryBytes(memory.size_bytes) : "Not written", mono: false },
    { label: "Updated", value: formatMemoryTime(memory.updated_at), mono: false },
    { label: "Consolidated", value: formatMemoryTime(memory.last_consolidated_at), mono: false },
    { label: "Journal", value: journalValue, mono: false },
    memory.last_run_id ? { label: "Run", value: memory.last_run_id, mono: true } : null,
  ].filter(Boolean);
}

export function memoryContentPlaceholder(memory) {
  if (!memory) return "Loading memory...";
  if (!memory.exists) return "No consolidated memory has been written yet.";
  return "";
}

function CapabilityGroup({
  title,
  hint,
  items = [],
  selected = [],
  mode = "all",
  onChange,
  emptyText,
  collapseAllSelected = false,
}) {
  const selectedNames = normalizedNames(selected);
  const selectedSet = new Set(selectedNames);
  const availableItems = items.filter((item) => item.available !== false);
  const availableIds = availableItems.map((item) => item.id);
  const explicit = allowlistMode(mode) === "custom";
  const includedCount = explicit
    ? selectedNames.filter((id) => availableIds.includes(id)).length
    : availableItems.length;
  const hasAvailable = availableItems.length > 0;
  const allSelected = hasAvailable && includedCount === availableItems.length;
  const summary = hasAvailable
    ? (!explicit ? "All available" : allSelected ? "Custom: all" : `${includedCount}/${availableItems.length} allowed`)
    : "None available";

  function applySelection(next) {
    const availableNext = next.filter((id) => availableIds.includes(id));
    if (collapseAllSelected && availableNext.length === availableIds.length) {
      onChange([], "all");
      return;
    }
    onChange(availableNext, "custom");
  }

  function toggle(item) {
    if (item.available === false) return;
    if (!explicit) {
      const next = availableIds.filter((id) => id !== item.id);
      applySelection(next);
      return;
    }
    const next = selectedSet.has(item.id)
      ? selectedNames.filter((id) => id !== item.id)
      : [...selectedNames, item.id];
    applySelection(next);
  }

  return (
    <section class="capability-panel">
      <div class="capability-panel-head">
        <div class="min-w-0">
          <div class="capability-panel-title">{title}</div>
          {hint && <div class="capability-panel-hint">{hint}</div>}
        </div>
        <div class="capability-panel-actions">
          <span class={`capability-mode ${!explicit ? "default" : explicit ? "explicit" : ""}`.trim()}>{summary}</span>
          {explicit && (
            <button type="button" class="link-button capability-reset" onClick={() => onChange([], "all")}>
              Reset to all
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div class="capability-empty">{emptyText}</div>
      ) : (
        <div class="capability-grid" role="group" aria-label={title}>
          {items.map((item) => {
            const available = item.available !== false;
            const active = explicit ? selectedSet.has(item.id) : available;
            const detail = available ? null : (item.unavailableReason || "Unavailable");
            return (
              <button
                key={item.id}
                type="button"
                class={`capability-tile ${active ? "active" : ""} ${active && !explicit ? "implicit" : ""}`.trim()}
                aria-pressed={active}
                disabled={!available}
                onClick={() => toggle(item)}
              >
                <span class="capability-tile-mark" aria-hidden="true">
                  <Icon name={active ? "check" : "plus"} size={12} strokeWidth={2.2} />
                </span>
                <span class="capability-tile-copy">
                  <span class="capability-tile-title">{item.label}</span>
                  {item.description && <span class="capability-tile-description">{item.description}</span>}
                  {detail && <span class="capability-tile-detail">{detail}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function AgentEdit({ name, onSaved, onDeleted }) {
  const isNew = name === "new";
  const [agent, setAgent] = useState(isNew ? emptyAgent : null);
  const [baseline, setBaseline] = useState(isNew ? emptyAgent : null);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [memoryState, setMemoryState] = useState(null);
  const [memoryError, setMemoryError] = useState(null);
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
  const modelChanged = !!baseline && agent?.model !== baseline.model;
  const selectedModelUnavailable = optionUnavailable(selectedModel);
  const modelSaveBlocked = (isNew || modelChanged) && selectedModelUnavailable;

  const loadMemory = useCallback(async () => {
    if (isNew) {
      setMemoryState(null);
      setMemoryError(null);
      return;
    }
    try {
      const res = await api.getAgentMemory(name);
      setMemoryState(res.memory || null);
      setMemoryError(null);
    } catch (err) {
      setMemoryState(null);
      setMemoryError(err?.message || "Memory state unavailable");
    }
  }, [isNew, name]);

  const loadCapabilityOptions = useCallback(() => {
    api.listSkills().then(r => setSkills(r.skills)).catch(() => setSkills([]));
    api.getMcpStatus().then(r => setMcpServers(r.servers || [])).catch(() => setMcpServers([]));
    api.listAvailableModels().then(r => setModelGroups(r.groups || [])).catch(() => setModelGroups([]));
  }, []);

  useEffect(() => {
    loadCapabilityOptions();
    if (!isNew) {
      api.getAgent(name).then(r => { setAgent(r.agent); setBaseline(r.agent); }).catch(() => setAgent({ notFound: true }));
    } else {
      setAgent(emptyAgent);
      setBaseline(emptyAgent);
    }
  }, [loadCapabilityOptions, name, isNew]);

  useEffect(() => { loadMemory(); }, [loadMemory]);

  const formSave = useFormSave(async () => {
    if (modelSaveBlocked) throw new Error(selectedModel?.unavailable_reason || "Selected model is unavailable");
    const enabledSkillNames = new Set(skills.filter((s) => s.enabled !== false).map((s) => s.name));
    const availableMcpNames = new Set(mcpServers.filter((s) => s.available !== false).map((s) => s.name));
    const skillsMode = allowlistMode(agent.skills_allowlist_mode);
    const mcpMode = allowlistMode(agent.mcp_allowlist_mode);
    const builtinMode = allowlistMode(agent.builtin_allowlist_mode);
    const payload = {
      ...agent,
      name: isNew ? undefined : agent.name,
      effort: normalizedEffort,
      skills_allowlist_mode: skillsMode,
      skills_allowlist: skillsMode === "all"
        ? []
        : normalizedNames(agent.skills_allowlist).filter((skill) => enabledSkillNames.has(skill)),
      mcp_allowlist_mode: mcpMode,
      mcp_allowlist: mcpMode === "all"
        ? []
        : normalizedNames(agent.mcp_allowlist).filter((server) => availableMcpNames.has(server)),
      builtin_allowlist_mode: builtinMode,
      builtin_allowlist: supportsToolUse && builtinMode === "custom"
        ? normalizedNames(agent.builtin_allowlist).filter((t) => visibleTools.includes(t))
        : [],
    };
    if (isNew) {
      const res = await api.createAgent(payload);
      pushToast("Agent created", { variant: "success" });
      setAgent(res.agent);
      setBaseline(res.agent);
      onSaved?.(res.agent.name);
    } else {
      const res = await api.patchAgent(name, payload);
      pushToast("Saved.", { variant: "success" });
      setAgent(res.agent);
      setBaseline(res.agent);
      onSaved?.(name);
    }
  });
  const isDirty = useMemo(() => baseline ? JSON.stringify(agent) !== JSON.stringify(baseline) : true, [agent, baseline]);
  useAppResume(() => {
    loadCapabilityOptions();
    loadMemory();
    if (isNew || isDirty) return;
    api.getAgent(name)
      .then((r) => {
        setAgent(r.agent);
        setBaseline(r.agent);
      })
      .catch(() => setAgent({ notFound: true }));
  });
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });
  const cancel = useCallback(() => {
    guard.requestNavigation("#/agents");
  }, [guard.requestNavigation]);

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
    Escape: () => cancel(),
  });

  useSSE("global", (evt) => {
    if (isNew || !name) return;
    const isThisAgent = evt.agent === name || evt.name === name;
    if (isThisAgent && (evt.type === "agent_consolidated" || (evt.type === "run_started" && evt.mode === "consolidate"))) {
      loadMemory();
    }
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
      label: modelGroupLabel(group),
      options: (group.models || []).map((m) => ({
        value: m.value,
        label: m.label || m.value,
        disabled: group.available === false || m.available === false || m.disabled === true,
        description: modelOptionDescription(m, group),
      })),
    })),
    ...(allModels.some((m) => m.value === agent.model) ? [] : [{
      label: "Saved value",
      options: [{ value: agent.model, label: `${agent.model} (unavailable)`, disabled: true, description: "Saved model is not in the current catalogue." }],
    }]),
  ];
  const effortOptions = reasoningLevels.map((level) => ({ value: level, label: level }));
  const useRadioForEffort = reasoningMode === "effort" && reasoningLevels.length >= 3 && reasoningLevels.length <= 5;
  const headerModelLabel = modelDisplayName(agent.model, modelOptions);
  const headerSlug = isNew ? "Slug after create" : agent.name;

  function setModel(model) {
    const opt = allModels.find((item) => item.value === model) || null;
    if (optionUnavailable(opt)) {
      pushToast(opt?.unavailable_reason || "Model is unavailable", { variant: "error" });
      return;
    }
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
      await loadMemory();
    } catch (err) {
      pushToast(`Consolidate failed: ${err.message}`, { variant: "error" });
    } finally {
      setConsolidating(false);
    }
  }

  const title = isNew ? "New agent" : (agent.display_name || agent.name);
  const availableSkillCount = skills.filter((skill) => skill.enabled !== false).length;
  const availableMcpCount = mcpServers.filter((server) => server.available !== false).length;
  const availableToolCount = supportsToolUse ? visibleTools.length : 0;
  const skillsMode = allowlistMode(agent.skills_allowlist_mode);
  const mcpMode = allowlistMode(agent.mcp_allowlist_mode);
  const builtinMode = allowlistMode(agent.builtin_allowlist_mode);
  const explicitSkillCount = normalizedNames(agent.skills_allowlist).length;
  const explicitMcpCount = normalizedNames(agent.mcp_allowlist).length;
  const explicitToolCount = normalizedNames(agent.builtin_allowlist).length;
  const capabilityMeta = [
    {
      label: "Skills",
      value: skillsMode === "custom" ? `${explicitSkillCount}/${availableSkillCount} allowed` : `${availableSkillCount} available`,
      mono: false,
    },
    {
      label: "MCP",
      value: mcpMode === "custom" ? `${explicitMcpCount}/${availableMcpCount} allowed` : `${availableMcpCount} available`,
      mono: false,
    },
    {
      label: "Built-ins",
      value: supportsToolUse
        ? (builtinMode === "custom" ? `${explicitToolCount}/${availableToolCount} allowed` : `${availableToolCount} available`)
        : "Unavailable",
      mono: false,
    },
    {
      label: "Browser tools",
      value: agent.browser_tools_review_only ? "Review only" : "All stages",
      mono: false,
    },
  ];
  const runtimeMeta = [
    { label: "Slug", value: isNew ? "Generated after create" : agent.name },
    { label: "SDK", value: agent.sdk || String(agent.model || "").split(":", 1)[0] || "—" },
    { label: "Model ref", value: agent.model },
    {
      label: "Reasoning",
      value: reasoningMode === "none"
        ? "Unavailable"
        : reasoningMode === "toggle"
          ? (normalizedEffort === "low" ? "Off" : "On")
          : normalizedEffort,
      mono: false,
    },
  ];
  const memoryLabel = memoryFreshnessLabel(memoryState);
  const memoryStatus = memoryFreshnessStatus(memoryState);
  const saveButtonVariant = isDirty || isNew ? "primary" : "secondary";
  const saveButtonLabel = isNew ? "Create" : "Save";
  const saveDisabled = !agent.display_name || modelSaveBlocked;
  const headerActions = (
    <>
      {!isNew && <StatusPill status={agent.enabled ? "enabled" : "disabled"} />}
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        onClick={() => formSave.save().catch(() => {})}
        loading={formSave.saving}
        disabled={saveDisabled}
      >
        {saveButtonLabel}
      </Button>
    </>
  );
  const mobileActionDock = (
    <>
      <Button variant="secondary" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        onClick={() => formSave.save().catch(() => {})}
        loading={formSave.saving}
        disabled={saveDisabled}
      >
        {saveButtonLabel}
      </Button>
    </>
  );

  function renderAgentRail() {
    return (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="Runtime snapshot" class="entity-rail-card">
          <EntityMetaList items={runtimeMeta} />
        </Card>
        <Card variant="spacious" title="Capability scope" class="entity-rail-card">
          <EntityMetaList items={capabilityMeta} />
        </Card>

        {!isNew && (
          <Card
            variant="spacious"
            title="Long-term memory"
            headerRight={<StatusPill status={memoryStatus} label={memoryLabel} size="sm" />}
            class="entity-rail-card agent-memory-card"
          >
            {memoryError && <div class="agent-memory-error">{memoryError}</div>}
            <EntityMetaList items={memoryMetaItems(memoryState)} />
            <Textarea
              rows={10}
              monospace
              readOnly
              class="agent-memory-textarea"
              aria-label="Long-term memory"
              value={memoryState?.content || ""}
              placeholder={memoryContentPlaceholder(memoryState)}
            />
            <div class="agent-memory-actions">
              <Button
                variant="secondary"
                iconLeft={<Icon name="refresh-cw" size={13} />}
                onClick={consolidateNow}
                loading={consolidating || memoryState?.freshness === "consolidating"}
                disabled={memoryState?.freshness === "consolidating"}
              >
                Consolidate memory
              </Button>
            </div>
          </Card>
        )}

        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }} class="entity-rail-card">
            <Button
              variant="destructive"
              iconLeft={<Icon name="trash" size={13} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete agent
            </Button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={isNew ? "New agent" : headerSlug} backLabel="Agents" onBack={cancel} />,
          mobileActionDock,
          drawerTitle: "Settings",
          drawerKicker: headerSlug,
          drawerContent: renderAgentRail(),
          sections: AGENT_EDIT_SECTIONS,
        }}
      />
      <DetailHead
        class="agent-detail-head entity-edit-head"
        backLabel="All agents"
        onBack={cancel}
        crumbs={[
          { label: "Agents", href: "#/agents" },
          { label: isNew ? "New" : "Edit" },
        ]}
        icon={!isNew ? <AgentAvatar name={agent.name} label={agent.display_name || agent.name} size={36} /> : null}
        iconFrame={false}
        kicker={isNew ? "Create agent" : "Agent"}
        title={title}
        meta={(
          <>
            <span class="pane-row-mono">{headerSlug}</span>
            <span class="pane-row-dot">·</span>
            <span>{headerModelLabel}</span>
            <span class="pane-row-dot">·</span>
            <span>{normalizedEffort} effort</span>
          </>
        )}
        actions={headerActions}
        subBar={<MobilePillRow railLabel="Settings" railCount={isNew ? 2 : 4} sections={AGENT_EDIT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body agent-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}
        {modelSaveBlocked && (
          <Banner
            variant="error"
            title="Selected model unavailable"
            detail={selectedModel?.unavailable_reason || "Choose an available model before saving."}
          />
        )}
        {notice && <Banner variant="info" detail={notice} />}

        <div class="entity-editor-layout agent-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="agent-edit-identity" num="01" kicker="Identity" meta="Profile" />
            <FormSection kicker="Identity" title="Profile">
              <FormGrid columns={3} class="agent-profile-grid">
                <FormField label="Display name" required>
                  <Input value={agent.display_name} onInput={(e) => setAgent({ ...agent, display_name: e.target.value })} />
                </FormField>
                <FormField label="Description">
                  <Input value={agent.description || ""} onInput={(e) => setAgent({ ...agent, description: e.target.value })} />
                </FormField>
                <FormField switchInside class="agent-availability-field">
                  <Switch
                    checked={agent.enabled}
                    onChange={(next) => setAgent({ ...agent, enabled: next })}
                    label="Available for assignment"
                    description="Unavailable agents stay configured but cannot be selected."
                  />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="agent-edit-runtime" num="02" kicker="Runtime" meta="Model" />
            <FormSection kicker="Runtime" title="Model & reasoning">
              <FormGrid columns={2}>
                <FormField label="Model" required>
                  <Select value={agent.model} options={modelOptions} onChange={setModel} searchable />
                </FormField>
                <FormField
                  label={reasoningMode === "toggle" ? "Thinking" : "Effort"}
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
                {visibleTools.length === 0
                  ? (selectedModel?.native_tools_note || "No Worklab built-in tools are exposed for this runtime.")
                  : `Tools: ${(visibleTools || BUILTIN_TOOLS).join(", ")}`}
                {selectedModel?.capabilities?.reasoning
                  ? ` · Reasoning: ${reasoningMode === "toggle" ? "toggle" : reasoningLevels.join(", ")}`
                  : " · Reasoning: unavailable"}
              </div>
            </FormSection>

            <SectionMarker id="agent-edit-policy" num="03" kicker="Policy" meta="Review" />
            <FormSection kicker="Policy" title="Review & budgets">
              <FormGrid columns={3}>
                <FormField switchInside>
                  <Switch
                    checked={!!agent.allow_self_review}
                    onChange={(next) => setAgent({ ...agent, allow_self_review: next })}
                    label="Allow self-review"
                    description="Reviewer may approve its own execute run."
                  />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={!!agent.browser_tools_review_only}
                    onChange={(next) => setAgent({ ...agent, browser_tools_review_only: next })}
                    label="Disable browser tools in execute"
                    description="Playwright MCP and Browser Use or Playwright skills stay available for review runs."
                  />
                </FormField>
                <FormField label="Daily budget">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={budgetInputValue(agent.daily_budget_usd)}
                    placeholder="No cap"
                    onInput={(e) => setAgent({ ...agent, daily_budget_usd: parseBudgetInput(e.target.value) })}
                  />
                </FormField>
                <FormField label="Per-run budget">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={budgetInputValue(agent.per_run_budget_usd)}
                    placeholder="No cap"
                    onInput={(e) => setAgent({ ...agent, per_run_budget_usd: parseBudgetInput(e.target.value) })}
                  />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="agent-edit-behavior" num="04" kicker="Behavior" meta="Prompt" />
            <FormSection kicker="Behavior" title="Instructions">
              <FormField label="System prompt role">
                <Textarea
                  rows={12}
                  monospace
                  autoGrow
                  value={agent.instructions}
                  onInput={(e) => setAgent({ ...agent, instructions: e.target.value })}
                />
              </FormField>
            </FormSection>

            <SectionMarker id="agent-edit-capabilities" num="05" kicker="Capabilities" meta="Scope" />
            <FormSection
              kicker="Capabilities"
              title="Allowlists"
              description="All available tools are included by default. Select tiles only when this agent should use a narrower scope."
            >
              <div class="capability-layout">
                <CapabilityGroup
                  title="Skills"
                  hint="Prompt packs this agent may use."
                  items={skills.map((skill) => ({
                    id: skill.name,
                    label: skill.display_name || skill.name,
                    description: skill.enabled !== false ? (skill.trigger || "Enabled skill") : "Disabled skill",
                    available: skill.enabled !== false,
                    unavailableReason: "Disabled skill",
                  }))}
                  selected={agent.skills_allowlist}
                  mode={skillsMode}
                  onChange={(next, mode) => setAgent({ ...agent, skills_allowlist: next, skills_allowlist_mode: mode })}
                  emptyText="No skills defined yet."
                />
                <CapabilityGroup
                  title="MCP servers"
                  hint="External tools and data connections."
                  items={mcpServers.map((server) => ({
                    id: server.name,
                    label: server.name,
                    description: server.available !== false
                      ? (server.source === "builtin" ? "Built in" : server.transport || "Registered")
                      : (server.unavailable_reason || "Unavailable"),
                    available: server.available !== false,
                    unavailableReason: server.unavailable_reason || "Unavailable",
                  }))}
                  selected={agent.mcp_allowlist}
                  mode={mcpMode}
                  onChange={(next, mode) => setAgent({ ...agent, mcp_allowlist: next, mcp_allowlist_mode: mode })}
                  emptyText="No MCP servers registered."
                />
                <CapabilityGroup
                  title="Built-in tools"
                  hint={supportsToolUse ? "Worklab-native file, shell, and web tools." : "This runtime cannot call Worklab built-in tools."}
                  items={supportsToolUse
                    ? visibleTools.map((tool) => ({
                      id: tool,
                      label: tool,
                      description: BUILTIN_TOOL_DESCRIPTIONS[tool] || "Runtime-provided built-in tool.",
                      available: true,
                    }))
                    : []}
                  selected={agent.builtin_allowlist}
                  mode={builtinMode}
                  onChange={(next, mode) => setAgent({ ...agent, builtin_allowlist: next, builtin_allowlist_mode: mode })}
                  emptyText={supportsToolUse ? "No built-in tools are available." : "This runtime cannot call Worklab built-in tools."}
                  collapseAllSelected
                />
              </div>
            </FormSection>
          </main>

          <aside class="entity-editor-rail is-mobile-drawer-source">
            {renderAgentRail()}
          </aside>
        </div>
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
        size="md"
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
