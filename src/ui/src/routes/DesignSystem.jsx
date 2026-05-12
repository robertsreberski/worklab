import { useState } from "preact/hooks";
import { AppShell, MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { Icon } from "../components/Icon.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { AgentLink, AgentReferenceText } from "../components/AgentLink.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { ProjectPicker } from "../components/ProjectPicker.jsx";
import { TeamPicker } from "../components/TeamPicker.jsx";
import { AgentEventTimeline } from "../components/AgentEventTimeline.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { Banner } from "../components/Banner.jsx";
import { Card } from "../components/Card.jsx";
import { CheckboxField } from "../components/CheckboxField.jsx";
import { CodeBlock } from "../components/CodeBlock.jsx";
import { CommanderRow } from "../components/CommanderRow.jsx";
import { CommentAuthor } from "../components/CommentAuthor.jsx";
import { CommentList } from "../components/CommentList.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { Drawer } from "../components/Drawer.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { EntityHeader } from "../components/EntityHeader.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { ErrorState } from "../components/ErrorState.jsx";
import { EventRow } from "../components/EventRow.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";
import { FileTree } from "../components/FileTree.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { GoalContractDetails } from "../components/GoalContractDetails.jsx";
import { KeyValueList } from "../components/KeyValueList.jsx";
import { LiveRunPanel } from "../components/LiveRunPanel.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { MentionableTextarea } from "../components/MentionableTextarea.jsx";
import { AttachmentTray } from "../components/AttachmentTray.jsx";
import { Metric } from "../components/Metric.jsx";
import { Modal } from "../components/Modal.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { ResourceGroup, ResourceList, ResourceListToolbar } from "../components/ResourceListToolbar.jsx";
import { RunHistoryNotice } from "../components/RunHistoryNotice.jsx";
import { StatusMenu } from "../components/StatusMenu.jsx";
import { StructuredContent } from "../components/StructuredContent.jsx";
import { StructuredValue } from "../components/StructuredValue.jsx";
import { SwitchField } from "../components/SwitchField.jsx";
import { ToolCallBlock } from "../components/ToolCallBlock.jsx";
import {
  Badge,
  Breadcrumb,
  Button,
  Checkbox,
  Chip,
  DatePicker,
  DateRangePicker,
  DateTimePicker,
  Divider,
  DurationInput,
  IconButton,
  Input,
  JsonField,
  Kbd,
  Link,
  LivePulse,
  NumberStepper,
  PathOrUrlInput,
  RadioGroup,
  SearchField,
  SecretInput,
  Select,
  ShimmerBar,
  ScheduleBuilder,
  StageToken,
  StatusDot,
  StatusPill,
  Switch,
  Tabs,
  TagInput,
  Textarea,
  TimePicker,
  ToolToken,
  Tooltip,
} from "../components/primitives/index.js";
import {
  ActionDock,
  ControlGroup,
  ControlGroupStack,
  DetailHead,
  DetailHeader,
  EditHeader,
  EntityEditorLayout,
  FilterBar,
  InlineHead,
  InlineEditorPanel,
  Page,
  PageHeader,
  PaneListHeader,
  PanelGrid,
  RailStack,
  SectionMarker,
  SectionGroup,
  SectionStack,
  SettingsMatrix,
  SummaryGrid,
  Toolbar,
  WorkflowLayout,
} from "../components/layout/index.js";

export const DESIGN_SYSTEM_COMPONENT_COVERAGE = [
  { name: "Badge", group: "primitive", coverage: "visible" },
  { name: "Breadcrumb", group: "primitive", coverage: "visible" },
  { name: "Button", group: "primitive", coverage: "visible" },
  { name: "Checkbox", group: "primitive", coverage: "visible" },
  { name: "Chip", group: "primitive", coverage: "visible" },
  { name: "DatePicker", group: "primitive", coverage: "visible" },
  { name: "DateRangePicker", group: "primitive", coverage: "visible" },
  { name: "DateTimePicker", group: "primitive", coverage: "visible" },
  { name: "Divider", group: "primitive", coverage: "visible" },
  { name: "DurationInput", group: "primitive", coverage: "visible" },
  { name: "IconButton", group: "primitive", coverage: "visible" },
  { name: "Input", group: "primitive", coverage: "visible" },
  { name: "JsonField", group: "primitive", coverage: "visible" },
  { name: "Kbd", group: "primitive", coverage: "visible" },
  { name: "Link", group: "primitive", coverage: "visible" },
  { name: "LivePulse", group: "primitive", coverage: "visible" },
  { name: "NumberStepper", group: "primitive", coverage: "visible" },
  { name: "PathOrUrlInput", group: "primitive", coverage: "visible" },
  { name: "RadioGroup", group: "primitive", coverage: "visible" },
  { name: "SearchField", group: "primitive", coverage: "visible" },
  { name: "SecretInput", group: "primitive", coverage: "visible" },
  { name: "Select", group: "primitive", coverage: "visible" },
  { name: "ShimmerBar", group: "primitive", coverage: "visible" },
  { name: "ScheduleBuilder", group: "primitive", coverage: "visible" },
  { name: "StageToken", group: "primitive", coverage: "visible" },
  { name: "StatusDot", group: "primitive", coverage: "visible" },
  { name: "StatusPill", group: "primitive", coverage: "visible" },
  { name: "Switch", group: "primitive", coverage: "visible" },
  { name: "Tabs", group: "primitive", coverage: "visible" },
  { name: "TagInput", group: "primitive", coverage: "visible" },
  { name: "Textarea", group: "primitive", coverage: "visible" },
  { name: "TimePicker", group: "primitive", coverage: "visible" },
  { name: "ToolToken", group: "primitive", coverage: "visible" },
  { name: "Tooltip", group: "primitive", coverage: "visible" },
  { name: "ActionDock", group: "layout", coverage: "visible" },
  { name: "ControlGroup", group: "layout", coverage: "visible" },
  { name: "ControlGroupStack", group: "layout", coverage: "visible" },
  { name: "DetailHead", group: "layout", coverage: "visible" },
  { name: "DetailHeader", group: "layout", coverage: "visible" },
  { name: "EditHeader", group: "layout", coverage: "visible" },
  { name: "EntityEditorLayout", group: "layout", coverage: "visible" },
  { name: "FilterBar", group: "layout", coverage: "visible" },
  { name: "InlineHead", group: "layout", coverage: "visible" },
  { name: "InlineEditorPanel", group: "layout", coverage: "visible" },
  { name: "Page", group: "layout", coverage: "visible" },
  { name: "PageHeader", group: "layout", coverage: "visible" },
  { name: "PaneListHeader", group: "layout", coverage: "visible" },
  { name: "PanelGrid", group: "layout", coverage: "visible" },
  { name: "RailStack", group: "layout", coverage: "visible" },
  { name: "SectionMarker", group: "layout", coverage: "visible" },
  { name: "SectionGroup", group: "layout", coverage: "visible" },
  { name: "SectionStack", group: "layout", coverage: "visible" },
  { name: "SettingsMatrix", group: "layout", coverage: "visible" },
  { name: "SummaryGrid", group: "layout", coverage: "visible" },
  { name: "Toolbar", group: "layout", coverage: "visible" },
  { name: "WorkflowLayout", group: "layout", coverage: "visible" },
  { name: "AdvancedMeta", group: "component", coverage: "visible" },
  { name: "AgentAvatar", group: "component", coverage: "visible" },
  { name: "AgentEventTimeline", group: "component", coverage: "visible" },
  { name: "AgentLink", group: "component", coverage: "visible" },
  { name: "AgentPicker", group: "component", coverage: "visible" },
  { name: "AgentReferenceText", group: "component", coverage: "visible" },
  { name: "AppShell", group: "component", coverage: "shell-hosted" },
  { name: "AssistantDock", group: "component", coverage: "shell-hosted" },
  { name: "AttachmentTray", group: "component", coverage: "visible" },
  { name: "Banner", group: "component", coverage: "visible" },
  { name: "Card", group: "component", coverage: "visible" },
  { name: "CheckboxField", group: "component", coverage: "visible" },
  { name: "CodeBlock", group: "component", coverage: "visible" },
  { name: "CommanderRow", group: "component", coverage: "visible" },
  { name: "CommentAuthor", group: "component", coverage: "visible" },
  { name: "CommentList", group: "component", coverage: "visible" },
  { name: "ConfirmButton", group: "component", coverage: "visible" },
  { name: "Drawer", group: "component", coverage: "visible" },
  { name: "EmptyState", group: "component", coverage: "visible" },
  { name: "EmptyStateFiltered", group: "component", coverage: "visible" },
  { name: "EntityHeader", group: "component", coverage: "visible" },
  { name: "EntityChromeBridge", group: "component", coverage: "shell-hosted" },
  { name: "EntityMetaList", group: "component", coverage: "visible" },
  { name: "ErrorState", group: "component", coverage: "visible" },
  { name: "EventRow", group: "component", coverage: "visible" },
  { name: "EventTimeline", group: "component", coverage: "visible" },
  { name: "FileTree", group: "component", coverage: "visible" },
  { name: "FormField", group: "component", coverage: "visible" },
  { name: "FormGrid", group: "component", coverage: "visible" },
  { name: "FormSection", group: "component", coverage: "visible" },
  { name: "GoalContractDetails", group: "component", coverage: "visible" },
  { name: "Icon", group: "component", coverage: "visible" },
  { name: "KeyValueList", group: "component", coverage: "visible" },
  { name: "KeyboardHelpDrawer", group: "component", coverage: "shell-hosted" },
  { name: "LiveRunPanel", group: "component", coverage: "visible" },
  { name: "LoadingState", group: "component", coverage: "visible" },
  { name: "MarkdownContent", group: "component", coverage: "visible" },
  { name: "MentionableTextarea", group: "component", coverage: "visible" },
  { name: "Metric", group: "component", coverage: "visible" },
  { name: "MobileConfigSheet", group: "component", coverage: "shell-hosted" },
  { name: "MobileConfigTrigger", group: "component", coverage: "shell-hosted" },
  { name: "MobilePillRow", group: "component", coverage: "visible" },
  { name: "MobileTopbar", group: "component", coverage: "visible" },
  { name: "Modal", group: "component", coverage: "visible" },
  { name: "PaneLayout", group: "component", coverage: "visible" },
  { name: "PaneRow", group: "component", coverage: "visible" },
  { name: "ProjectPicker", group: "component", coverage: "visible" },
  { name: "ResourceGroup", group: "component", coverage: "visible" },
  { name: "ResourceList", group: "component", coverage: "visible" },
  { name: "ResourceListToolbar", group: "component", coverage: "visible" },
  { name: "ResourceRowChip", group: "component", coverage: "visible" },
  { name: "ResourceRowId", group: "component", coverage: "visible" },
  { name: "ResourceRowPath", group: "component", coverage: "visible" },
  { name: "ResourceRowTags", group: "component", coverage: "visible" },
  { name: "RunHistoryNotice", group: "component", coverage: "visible" },
  { name: "RunTodoPanel", group: "component", coverage: "visible" },
  { name: "StatusMenu", group: "component", coverage: "visible" },
  { name: "StructuredContent", group: "component", coverage: "visible" },
  { name: "StructuredValue", group: "component", coverage: "visible" },
  { name: "SwitchField", group: "component", coverage: "visible" },
  { name: "TeamPicker", group: "component", coverage: "visible" },
  { name: "ToastHost", group: "component", coverage: "shell-hosted" },
  { name: "ToolCallBlock", group: "component", coverage: "visible" },
];

const STATUS_TABS = [
  { value: "all", label: "All", count: 12 },
  { value: "active", label: "Active", count: 4 },
  { value: "done", label: "Done", count: 8 },
];

const MODE_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "balanced", label: "Balanced" },
  { value: "expanded", label: "Expanded" },
];

const SELECT_OPTIONS = [
  { value: "codex", label: "Codex", description: "Local coding agent" },
  { value: "claude", label: "Claude Code", description: "Terminal coding agent" },
  { value: "custom", label: "Custom provider", description: "Configured model route" },
];

const DEMO_AGENTS = [
  { name: "planner", display_name: "Planner", provider_kind: "codex", model: "gpt-5.4", effort: "medium", enabled: true },
  { name: "builder", display_name: "Builder", provider_kind: "codex", model: "gpt-5.4", effort: "high", enabled: true },
  { name: "reviewer", display_name: "Reviewer", provider_kind: "codex", model: "gpt-5.4", effort: "medium", enabled: true },
];

const DEMO_TEAMS = [
  { id: "product-team", slug: "product-team", name: "Product Team", member_count: 3, status: "active" },
  { id: "qa-team", slug: "qa-team", name: "QA Team", member_count: 2, status: "active" },
];

const DEMO_PROJECTS = [
  { id: "mobile-shell", slug: "mobile-shell", name: "Mobile Shell", archived: false, workdir: "/repos/mobile-shell", worktree_mode: "auto" },
  { id: "legacy-flow", slug: "legacy-flow", name: "Legacy Flow", archived: true, workdir: "/repos/legacy-flow", worktree_mode: "off" },
];

const DEMO_EVENTS = [
  { type: "started", _event_seq: 1 },
  { type: "thinking", text: "Inspecting the shared UI surface.", _event_seq: 2 },
  { type: "tool_use", name: "read_file", input: { path: "src/ui/src/styles.css" }, status: "done", _event_seq: 3 },
  { type: "final", text: "Catalog updated.", usage: { input_tokens: 1200, output_tokens: 420 }, durationMs: 1800, _event_seq: 4 },
];

const DEMO_TASK = {
  id: "task-design-system",
  task_key: "WL-DS",
  title: "Sync design system coverage",
  stage: "execute",
  owner_agent: "builder",
  planner_agent: "planner",
  reviewer_agent: "reviewer",
  running_run_id: "run-design-system",
  running_run: {
    id: "run-design-system",
    last_event: { type: "tool_use", name: "mcp__worklab__journal_append", input: { task: "coverage" }, status: "running", _event_seq: 12 },
  },
  project: { id: "worklab", slug: "worklab", name: "Worklab" },
  updated_at: Date.now() - 1000 * 60 * 8,
};

const DEMO_RUN = {
  id: "run-design-system",
  mode: "execute",
  provider_kind: "codex",
  agent_name: "builder",
  process_status: "running",
  status: "running",
  input_tokens: 1200,
  output_tokens: 420,
  duration_ms: 1800,
  num_turns: 3,
  live_input: { supported: false },
};

const DEMO_TREE = [
  {
    type: "folder",
    name: "components",
    children: [
      { type: "file", name: "Button.jsx", path: "src/ui/src/components/primitives/Button.jsx" },
      { type: "file", name: "DesignSystem.jsx", path: "src/ui/src/routes/DesignSystem.jsx" },
    ],
  },
];

function Swatch({ name, value }) {
  return (
    <div class="ds-swatch">
      <span class="ds-swatch-chip" style={{ "--swatch": `var(${value})` }} />
      <span class="ds-swatch-name">{name}</span>
      <span class="ds-swatch-value">{value}</span>
    </div>
  );
}

function CoverageGrid({ group }) {
  const items = DESIGN_SYSTEM_COMPONENT_COVERAGE.filter((item) => item.group === group);
  return (
    <PanelGrid class="ds-rubric-grid">
      {items.map((item) => (
        <div key={item.name}>
          <strong>{item.name}</strong>
          <span>{item.coverage === "shell-hosted" ? "Hosted by AppShell" : "Visible example"}</span>
        </div>
      ))}
    </PanelGrid>
  );
}

export function DesignSystem() {
  const [tab, setTab] = useState("all");
  const [mode, setMode] = useState("balanced");
  const [provider, setProvider] = useState("codex");
  const [agent, setAgent] = useState("builder");
  const [team, setTeam] = useState("product-team");
  const [project, setProject] = useState("mobile-shell");
  const [enabled, setEnabled] = useState(true);
  const [checked, setChecked] = useState(true);
  const [legacyChecked, setLegacyChecked] = useState(true);
  const [date, setDate] = useState("2026-04-29");
  const [time, setTime] = useState("09:15");
  const [dateRange, setDateRange] = useState({ from: "2026-04-23", to: "2026-04-29" });
  const [runAt, setRunAt] = useState(new Date(2026, 3, 29, 9, 15).getTime());
  const [schedule, setSchedule] = useState({ type: "weekly", weekdays: [1, 3], hour: 9, minute: 15 });
  const [duration, setDuration] = useState(30 * 60 * 1000);
  const [limit, setLimit] = useState(80);
  const [tags, setTags] = useState(["triage", "review"]);
  const [secret, setSecret] = useState("sk-local-demo");
  const [jsonText, setJsonText] = useState('{"Authorization":"Bearer token"}');
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const streamState = {
    run: DEMO_RUN,
    events: DEMO_EVENTS,
    eventCount: 8,
    eventsTruncated: true,
    fullHistoryLoaded: false,
    loading: false,
    done: false,
    loadFullHistory: () => {},
  };

  return (
    <AppShell route="design-system">
      <Page
        class="ds-catalog"
        kicker="Internal"
        title="Design System"
        description="Tokens, shared components, layout patterns, and responsive surfaces used by Worklab."
        actions={(
          <>
            <Button variant="secondary" iconLeft={<Icon name="refresh-cw" size={13} />}>Refresh</Button>
            <Button variant="primary" iconLeft={<Icon name="plus" size={13} />}>Primary</Button>
          </>
        )}
      >
        <section class="ds-catalog-section">
          <Card title="UX Rubric">
            <SettingsMatrix>
              <Metric label="Earns space" value="1" unit="job" />
              <Metric label="Default" value="Next" unit="action" />
              <Metric label="Hidden" value="Rare" unit="controls" />
            </SettingsMatrix>
            <PanelGrid class="ds-rubric-grid">
              <div><strong>Surface</strong><span>Show only the decision or action needed for the current state.</span></div>
              <div><strong>Timing</strong><span>Reveal advanced fields after intent is declared.</span></div>
              <div><strong>Input</strong><span>Use domain controls for dates, durations, secrets, JSON, and schedules.</span></div>
            </PanelGrid>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Tokens">
            <PanelGrid class="ds-swatch-grid">
              <Swatch name="Background" value="--bg" />
              <Swatch name="Surface" value="--surface" />
              <Swatch name="Elevated" value="--surface-elevated" />
              <Swatch name="Accent" value="--accent" />
              <Swatch name="Progress" value="--status-progress" />
              <Swatch name="Error" value="--status-error" />
            </PanelGrid>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Primitive Coverage">
            <CoverageGrid group="primitive" />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Actions, Tokens, And Navigation">
            <div class="ds-catalog-row">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <ConfirmButton onConfirm={() => {}}>ConfirmButton</ConfirmButton>
              <Tooltip label="Icon action">
                <IconButton icon={<Icon name="settings" size={14} />} aria-label="Settings" />
              </Tooltip>
            </div>
            <Divider />
            <div class="ds-catalog-row">
              <StatusPill status="running" />
              <StatusPill status="done" />
              <StatusPill status="error" />
              <StageToken stage="plan" />
              <StageToken stage="running" />
              <StageToken stage="review" variant="menu" />
              <StatusDot status="running" pulse />
              <LivePulse />
              <Chip variant="muted">tag · infra-api</Chip>
              <Chip variant="accent">link · goal</Chip>
              <Chip variant="warn">pending · 3 actions</Chip>
              <Chip variant="error">alert · stuck</Chip>
              <Chip variant="inline">⚡ auto · daily 9am</Chip>
              <Badge>7</Badge>
              <Kbd>?</Kbd>
            </div>
            <Divider />
            <div class="ds-catalog-row">
              <Breadcrumb items={[{ label: "Design system", href: "#/design-system" }, { label: "Primitives" }]} />
              <Link href="#/settings">Internal link</Link>
              <Link href="https://example.com" external>External link</Link>
            </div>
            <Divider />
            <ShimmerBar />
            <div class="ds-catalog-row">
              <ToolToken event={{ type: "tool_use", name: "mcp__worklab__journal_append", input: { task: "coverage" }, status: "running" }} />
              <ToolToken event={{ type: "thinking", text: "Thinking through component parity." }} />
              <ToolToken event={{ type: "text", text: "Catalog synced." }} />
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Forms">
            <FormSection kicker="Shared form wrappers" title="FormSection" description="Use FormField and FormGrid around primitive controls.">
              <FormGrid columns={2}>
                <FormField label="Name" required>
                  <Input value="Regression Agent" readOnly />
                </FormField>
                <FormField label="Provider">
                  <Select value={provider} onChange={setProvider} options={SELECT_OPTIONS} />
                </FormField>
                <FormField label="Density" class="span-2">
                  <RadioGroup value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Density" />
                </FormField>
                <FormField switchInside>
                  <Switch checked={enabled} onChange={setEnabled} label="Available" description="Can be assigned to new work." />
                </FormField>
                <FormField switchInside>
                  <Checkbox checked={checked} onChange={setChecked} label="Require review" description="Route completed work through a reviewer." />
                </FormField>
                <FormField switchInside>
                  <SwitchField checked={enabled} onChange={(event) => setEnabled(event.target.checked)} label="SwitchField wrapper" description="Compatibility wrapper." />
                </FormField>
                <FormField switchInside>
                  <CheckboxField checked={legacyChecked} onChange={(event) => setLegacyChecked(event.target.checked)}>CheckboxField wrapper</CheckboxField>
                </FormField>
                <FormField label="Instructions" class="span-2">
                  <Textarea value="Plan carefully, keep edits scoped, and report concrete outcomes." readOnly />
                </FormField>
                <FormField label="Mentionable instructions" class="span-2" hint="Type @ to open the cross-entity mention picker.">
                  <MentionableTextarea value="Hand off to @agent/triager when ready." readOnly />
                </FormField>
                <FormField label="Attachments" class="span-2">
                  <AttachmentTray
                    attachments={[
                      { kind: "path", label: "Run input", path_text: "src/core/run-input.js" },
                      { kind: "upload", label: "Clipboard", filename: "clipboard.png", mime_type: "image/png", size_bytes: 1204 },
                    ]}
                    disabled
                  />
                </FormField>
              </FormGrid>
            </FormSection>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Domain Inputs">
            <FormGrid columns={2}>
              <FormField label="Date">
                <DatePicker value={date} onChange={setDate} />
              </FormField>
              <FormField label="Time">
                <TimePicker value={time} onChange={setTime} />
              </FormField>
              <FormField label="Date range" class="span-2">
                <DateRangePicker value={dateRange} onChange={setDateRange} />
              </FormField>
              <FormField label="Run at" class="span-2">
                <DateTimePicker value={runAt} onChange={setRunAt} />
              </FormField>
              <FormField label="Duration">
                <DurationInput value={duration} onChange={setDuration} />
              </FormField>
              <FormField label="Limit">
                <NumberStepper value={limit} min={0} max={100} onChange={setLimit} ariaLabel="Limit" />
              </FormField>
              <FormField label="Secret" class="span-2">
                <SecretInput value={secret} onInput={(event) => setSecret(event.currentTarget.value)} />
              </FormField>
              <FormField label="Path or URL" class="span-2">
                <PathOrUrlInput kind="url" value="http://localhost:3000/mcp" readOnly />
              </FormField>
              <FormField label="Tags" class="span-2">
                <TagInput value={tags} onChange={setTags} />
              </FormField>
              <FormField label="JSON" class="span-2">
                <JsonField value={jsonText} onInput={(event) => setJsonText(event.currentTarget.value)} />
              </FormField>
            </FormGrid>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Schedule Builder">
            <ScheduleBuilder value={schedule} onChange={setSchedule} />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Layout Coverage">
            <CoverageGrid group="layout" />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Page And List Layouts">
            <PageHeader
              kicker="PageHeader"
              title="Reusable Page Header"
              description="Page composes this header with route content."
              actions={<Toolbar><Button variant="secondary">Secondary</Button><Button variant="primary">Primary</Button></Toolbar>}
            />
            <SummaryGrid>
              <Metric label="Open" value="12" />
              <Metric label="Running" value="4" />
              <Metric label="Done" value="29" />
            </SummaryGrid>
            <PanelGrid>
              <Card title="Toolbar">
                <Toolbar align="start">
                  <SearchField value={search} onInput={(event) => setSearch(event.target.value)} placeholder="Search..." />
                  <Tabs value={tab} onChange={setTab} tabs={STATUS_TABS} class="tabs-pills" ariaLabel="Status" />
                </Toolbar>
              </Card>
              <Card title="InlineHead">
                <InlineHead>
                  <div>
                    <span class="soft-meta">Inline head</span>
                    <strong>Shared title/action row</strong>
                  </div>
                  <Badge variant="muted">Meta</Badge>
                </InlineHead>
              </Card>
              <Card title="FilterBar">
                <FilterBar
                  searchValue={search}
                  onSearch={setSearch}
                  filters={<><Select value={provider} onChange={setProvider} options={SELECT_OPTIONS} /><DateRangePicker value={dateRange} onChange={setDateRange} /></>}
                  activeCount={2}
                  onClear={() => setDateRange({ from: "", to: "" })}
                />
              </Card>
              <Card title="PaneListHeader">
                <PaneListHeader
                  searchValue={search}
                  onSearch={setSearch}
                  searchPlaceholder="Search list"
                  actionLabel="New"
                  onAction={() => {}}
                />
              </Card>
              <Card title="ResourceList">
                <ResourceListToolbar
                  searchValue={search}
                  onSearch={setSearch}
                  searchPlaceholder="Search resources"
                  searchAriaLabel="Search resources"
                  countLabel="2 shown"
                  actionLabel="New"
                  onAction={() => {}}
                >
                  <Tabs value={tab} onChange={setTab} tabs={STATUS_TABS} ariaLabel="Filter resources" class="tabs-pills" />
                </ResourceListToolbar>
                <ResourceList>
                  <ResourceGroup group={{ label: "Active", items: [{ id: "one" }, { id: "two" }] }}>
                    <PaneRow title="Agent builder" sub="Resource row inside shared list" trailing={<StatusPill status="running" size="sm" />} />
                    <PaneRow title="Project docs" sub="Grouped by ResourceGroup" trailing={<StatusPill status="done" size="sm" />} />
                  </ResourceGroup>
                </ResourceList>
              </Card>
              <Card title="ActionDock">
                <ActionDock
                  secondary={<Button variant="ghost">Cancel</Button>}
                  overflow={<Button variant="secondary">Preview</Button>}
                  primary={<Button variant="primary">Save</Button>}
                />
              </Card>
              <Card title="SectionGroup">
                <SectionStack>
                  <SectionGroup label="Todo" count={3}>
                    <div class="ds-catalog-row">
                      <StatusPill status="queued" size="sm" />
                      <StatusPill status="running" size="sm" />
                    </div>
                  </SectionGroup>
                  <SectionGroup label="Done" count={1}>
                    <StatusPill status="done" size="sm" />
                  </SectionGroup>
                </SectionStack>
              </Card>
              <Card title="ControlGroup">
                <ControlGroupStack>
                  <ControlGroup title="Budgets" description="Dense controls with a grouped heading.">
                    <FormField label="Warn turns">
                      <NumberStepper min={1} max={1000} value={150} ariaLabel="Warn turns" onChange={() => {}} />
                    </FormField>
                    <FormField label="Max turns">
                      <NumberStepper min={1} max={1000} value={300} ariaLabel="Max turns" onChange={() => {}} />
                    </FormField>
                  </ControlGroup>
                </ControlGroupStack>
              </Card>
            </PanelGrid>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Pane Layout">
            <div style={{ height: "260px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
              <PaneLayout
                hasSelection
                listHeader={<PaneListHeader searchValue="" searchPlaceholder="Search" actionLabel="New" />}
                listBody={(
                  <>
                    <PaneRow title="Design system route" sub="Selected shared component surface" trailing={<StatusPill status="running" size="sm" />} />
                    <PaneRow title="Settings route" sub="Structured admin controls" trailing={<StatusPill status="done" size="sm" />} />
                  </>
                )}
                detail={(
                  <div class="pane-detail-body">
                    <DetailHeader
                      icon={<Icon name="layout-list" size={18} />}
                      kicker="DetailHeader"
                      title="Reusable detail"
                      meta={<span>PaneLayout detail surface</span>}
                      actions={<Button variant="secondary" size="sm">Edit</Button>}
                    />
                    <Card title="Detail panel">PaneLayout hosts list and detail routes.</Card>
                  </div>
                )}
              />
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <div class="pane-detail">
            <DetailHead
              icon={<Icon name="layout-list" size={18} />}
              crumbs={[{ label: "Design system", href: "#/design-system" }, { label: "Detail" }]}
              kicker="Entity"
              title="Reusable Detail Header"
              meta={<><span class="pane-row-mono">WL-DS</span><span class="pane-row-dot">·</span><span>Responsive</span></>}
              actions={<><Button variant="ghost">Cancel</Button><Button variant="primary">Save</Button></>}
              subBar={<><StageToken stage="running" /><span class="soft-meta">Canonical header</span></>}
            />
            <div class="pane-detail-body entity-detail-body">
              <EntityEditorLayout
                main={(
                  <>
                    <SectionMarker num="01" kicker="Section marker" meta="Shared primitive" />
                    <Card title="Main Surface">
                      <p class="soft-meta">Entity editors use this grid before route-specific fields are added.</p>
                    </Card>
                    <InlineEditorPanel title="InlineEditorPanel" description="Appears only after the user chooses to edit.">
                      <Input value="Inline value" readOnly />
                    </InlineEditorPanel>
                  </>
                )}
                rail={(
                  <RailStack>
                    <Card title="Rail Card" class="entity-rail-card">Runtime metadata</Card>
                    <AdvancedMeta title="AdvancedMeta" items={[{ label: "ID", value: "wl-demo" }, { label: "Mode", value: "execute" }]} />
                  </RailStack>
                )}
              />
            </div>
          </div>
        </section>

        <section class="ds-catalog-section">
          <Card title="Workflow Layout">
            <WorkflowLayout
              hero={<DetailHead icon={<Icon name="clock" size={16} />} title="Scheduled Work" meta={<StageToken stage="plan" />} actions={<Button variant="primary">Run</Button>} />}
              main={<InlineEditorPanel title="Inline editor" description="Appears only after the user chooses to edit."><ScheduleBuilder value={schedule} onChange={setSchedule} /></InlineEditorPanel>}
              rail={<RailStack><Card title="Context">Only persistent context belongs in the rail.</Card><Card collapsible={{ summary: "Advanced", count: 2 }}>Rare actions stay collapsed.</Card></RailStack>}
            />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Edit Header And Mobile Chrome">
            <EditHeader
              backLabel="Back"
              onBack={() => {}}
              breadcrumbs={[{ label: "Tasks", href: "#/tasks" }, { label: "New task" }]}
              kicker="EditHeader"
              title="New task"
              meta="Unsaved draft"
              icon={<Icon name="file-text" size={17} />}
              actions={<><Button variant="ghost">Discard</Button><Button variant="primary">Save</Button></>}
            />
            <MobileTopbar title="MobileTopbar" backLabel="Tasks" onBack={() => {}} />
            <div class="ds-catalog-row">
              <MobilePillRow railLabel="Rail" railCount={3} sections={[{ id: "one" }, { id: "two" }]} extra={<Chip variant="accent">MobilePillRow</Chip>} />
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Component Coverage">
            <CoverageGrid group="component" />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Entity And Agent Components">
            <EntityHeader
              eyebrow="EntityHeader"
              title="Component inventory"
              description="Reusable entity header with meta and actions."
              meta={<EntityMetaList items={[{ label: "Kind", value: "component" }, { label: "Status", value: "covered" }]} />}
              actions={<Button variant="secondary">Action</Button>}
            />
            <div class="ds-catalog-row">
              <AgentAvatar name="builder" label="Builder" role="owner" />
              <AgentLink name="builder" agents={DEMO_AGENTS} showAvatar />
              <span class="soft-meta"><AgentReferenceText text="References @builder inline." agents={DEMO_AGENTS} /></span>
              <CommentAuthor authorType="agent" authorId="builder" agents={DEMO_AGENTS} />
            </div>
            <FormField label="AgentPicker">
              <AgentPicker value={agent} onChange={setAgent} agents={DEMO_AGENTS} />
            </FormField>
            <FormField label="ProjectPicker">
              <ProjectPicker value={project} onChange={setProject} projects={DEMO_PROJECTS} />
            </FormField>
            <FormField label="TeamPicker">
              <TeamPicker value={team} onChange={setTeam} teams={DEMO_TEAMS} />
            </FormField>
            <KeyValueList entries={[["Owner", "builder"], ["Reviewer", "reviewer"]]} />
            <GoalContractDetails
              goal={{
                contract: {
                  objective: "Keep shared components reusable.",
                  stopping_condition: "No duplicate route-local component.",
                  validation_loop: "Catalog, tests, and browser sweep.",
                  constraints: ["Use shared primitives"],
                },
                goal_status_reason: "Component inventory is current.",
              }}
            />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Commander Row And Status Menu">
            <CommanderRow
              task={DEMO_TASK}
              agents={DEMO_AGENTS}
              selected
              checked={checked}
              onToggleCheck={setChecked}
              runProgressEvents={DEMO_EVENTS}
            />
            <div class="ds-catalog-row">
              <StatusMenu status="plan" onChoose={() => {}} />
              <StatusMenu status="review" onChoose={() => {}} />
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Feedback And Overlays">
            <PanelGrid>
              <Banner title="Banner" detail="Inline contextual feedback." variant="info" />
              <Banner title="Warning banner" detail="Warn and error variants keep status semantics." variant="warn" />
              <LoadingState caption="LoadingState" />
              <ErrorState message="ErrorState with retry affordance." onRetry={() => {}} />
              <EmptyState title="EmptyState" body="No records yet." cta={<Button variant="primary">Create</Button>} icon={<Icon name="book" size={28} />} />
              <EmptyStateFiltered onClearFilters={() => {}} icon={<Icon name="filter" size={28} />} />
            </PanelGrid>
            <div class="ds-catalog-row">
              <Button variant="secondary" onClick={() => setModalOpen(true)}>Open Modal</Button>
              <Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open Drawer</Button>
            </div>
            <Modal
              open={modalOpen}
              onClose={() => setModalOpen(false)}
              title="Modal"
              footer={<ActionDock secondary={<Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>} primary={<Button variant="primary" onClick={() => setModalOpen(false)}>Save</Button>} />}
            >
              <StructuredContent content="Blocking overlays use focus traps and scoped action docks." />
            </Modal>
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Drawer">
              <StructuredContent content="Drawer is a right-side contextual surface for secondary work." />
            </Drawer>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Content Components">
            <PanelGrid>
              <Card title="MarkdownContent">
                <MarkdownContent content={"### Markdown\n\n- Autolinks and code blocks stay inside document surfaces.\n\n```js\nconst ok = true;\n```"} maxHeight={220} />
              </Card>
              <Card title="StructuredContent">
                <StructuredContent content={'Result:\n\n```json\n{"summary":"Structured content","decision":"advance"}\n```'} />
              </Card>
              <Card title="StructuredValue">
                <StructuredValue title="Worklab result" value={{ schema: "worklab.v2", decision: "advance", summary: "Catalog covered", artifacts: { changed: 3 } }} />
              </Card>
              <Card title="CodeBlock">
                <CodeBlock language="js" code={"export const covered = true;"} />
              </Card>
              <Card title="FileTree">
                <FileTree files={DEMO_TREE} highlightSkillFile />
              </Card>
            </PanelGrid>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Comments And Run History">
            <CommentList
              agents={DEMO_AGENTS}
              comments={[
                { id: "c1", author_type: "human", author_id: "Robert", created_at: Date.now() - 60000, body: "Please keep the catalog 1:1." },
                { id: "c2", author_type: "agent", author_id: "builder", created_at: Date.now() - 30000, body: "Updated shared component coverage." },
              ]}
            />
            <RunHistoryNotice
              eventCount={8}
              visibleCount={4}
              eventsTruncated
              onLoadFullHistory={() => {}}
              rawLogHref="/api/runs/run-design-system/raw-log"
            />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Timeline Components">
            <EventRow kind="phase" label="EventRow" relativeMs={120} durationMs={900} isStreaming>
              <span class="soft-meta">Single timeline atom.</span>
            </EventRow>
            <EventTimeline events={DEMO_EVENTS} streaming />
            <AgentEventTimeline events={DEMO_EVENTS} streaming />
            <ToolCallBlock
              toolUse={{ name: "file_edit", input: { changes: [{ path: "src/ui/src/routes/DesignSystem.jsx", kind: "update" }] } }}
              toolResult={{ output: { status: "completed", changes: [{ path: "src/ui/src/routes/DesignSystem.jsx", kind: "update", line_stats: { added: 24, removed: 3 } }] } }}
              messageStatus="complete"
            />
            <LiveRunPanel run={DEMO_RUN} events={DEMO_EVENTS} isStreaming agentLabel="Builder" streamState={streamState} />
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Shell Hosted Components">
            <PanelGrid class="ds-rubric-grid">
              <div><strong>AppShell</strong><span>This catalog is rendered inside the shared shell.</span></div>
              <div><strong>AssistantDock</strong><span>Mounted by AppShell and opened from the global assistant control.</span></div>
              <div><strong>KeyboardHelpDrawer</strong><span>Mounted by AppShell and opened with the keyboard help shortcut.</span></div>
              <div><strong>ToastHost</strong><span>Mounted globally so notifications stack above route content.</span></div>
            </PanelGrid>
          </Card>
        </section>
      </Page>
    </AppShell>
  );
}
