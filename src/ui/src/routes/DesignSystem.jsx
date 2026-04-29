import { useState } from "preact/hooks";
import { AppShell } from "../components/AppShell.jsx";
import { Icon } from "../components/Icon.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Card } from "../components/Card.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { Metric } from "../components/Metric.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import {
  Badge,
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
  NumberStepper,
  PathOrUrlInput,
  RadioGroup,
  SearchField,
  Select,
  SecretInput,
  ScheduleBuilder,
  StatusDot,
  StatusPill,
  Switch,
  Tabs,
  TagInput,
  Textarea,
  TimePicker,
  Tooltip,
} from "../components/primitives/index.js";
import {
  ActionDock,
  DetailHeader,
  EntityEditorLayout,
  FilterBar,
  InlineEditorPanel,
  Page,
  PanelGrid,
  RailStack,
  SettingsMatrix,
  SummaryGrid,
  Toolbar,
  WorkflowLayout,
} from "../components/layout/index.js";

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

function Swatch({ name, value }) {
  return (
    <div class="ds-swatch">
      <span class="ds-swatch-chip" style={{ "--swatch": `var(${value})` }} />
      <span class="ds-swatch-name">{name}</span>
      <span class="ds-swatch-value">{value}</span>
    </div>
  );
}

export function DesignSystem() {
  const [tab, setTab] = useState("all");
  const [mode, setMode] = useState("balanced");
  const [provider, setProvider] = useState("codex");
  const [enabled, setEnabled] = useState(true);
  const [checked, setChecked] = useState(true);
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

  return (
    <AppShell route="design-system">
      <Page
        class="ds-catalog"
        kicker="Internal"
        title="Design System"
        description="Retro console components, layout patterns, and responsive surfaces used by Worklab."
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
            <div class="ds-rubric-grid">
              <div><strong>Surface</strong><span>Show only the decision or action needed for the current state.</span></div>
              <div><strong>Timing</strong><span>Reveal advanced fields after intent is declared.</span></div>
              <div><strong>Input</strong><span>Use domain controls for dates, durations, secrets, JSON, and schedules.</span></div>
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Tokens">
            <div class="ds-swatch-grid">
              <Swatch name="Background" value="--bg" />
              <Swatch name="Surface" value="--surface" />
              <Swatch name="Elevated" value="--surface-elevated" />
              <Swatch name="Accent" value="--accent" />
              <Swatch name="Progress" value="--status-progress" />
              <Swatch name="Error" value="--status-error" />
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Primitives">
            <div class="ds-catalog-row">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Tooltip label="Icon action">
                <IconButton icon={<Icon name="settings" size={14} />} aria-label="Settings" />
              </Tooltip>
            </div>
            <Divider />
            <div class="ds-catalog-row">
              <StatusPill status="running" />
              <StatusPill status="done" />
              <StatusPill status="error" />
              <StatusDot status="running" pulse />
              <Chip variant="accent">agent</Chip>
              <Chip variant="warn">queued</Chip>
              <Badge>7</Badge>
              <Kbd>?</Kbd>
            </div>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <Card title="Forms">
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
              <FormField label="Instructions" class="span-2">
                <Textarea value="Plan carefully, keep edits scoped, and report concrete outcomes." readOnly />
              </FormField>
            </FormGrid>
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
          <Card title="Layouts">
            <SummaryGrid>
              <Metric label="Open" value="12" />
              <Metric label="Running" value="4" />
              <Metric label="Done" value="29" />
            </SummaryGrid>
            <PanelGrid>
              <Card title="Toolbar">
                <Toolbar align="start">
                  <SearchField value="" placeholder="Search..." />
                  <Tabs value={tab} onChange={setTab} tabs={STATUS_TABS} class="tabs-pills" ariaLabel="Status" />
                </Toolbar>
              </Card>
              <Card title="Filter Bar">
                <FilterBar
                  searchValue=""
                  onSearch={() => {}}
                  filters={<><Select value={provider} onChange={setProvider} options={SELECT_OPTIONS} /><DateRangePicker value={dateRange} onChange={setDateRange} /></>}
                  activeCount={2}
                  onClear={() => setDateRange({ from: "", to: "" })}
                />
              </Card>
              <Card title="Rows">
                <PaneRow
                  title="Retro console migration"
                  leading={<AgentAvatar name="design-system" label="Design System" />}
                  sub={<span class="pane-row-description">Reusable row pattern with leading identity, title, meta, and status.</span>}
                  trailing={<StatusPill status="review" />}
                />
              </Card>
              <Card title="Action Dock">
                <ActionDock
                  secondary={<Button variant="ghost">Cancel</Button>}
                  overflow={<Button variant="secondary">Preview</Button>}
                  primary={<Button variant="primary">Save</Button>}
                />
              </Card>
            </PanelGrid>
          </Card>
        </section>

        <section class="ds-catalog-section">
          <div class="pane-detail">
            <DetailHeader
              icon={<Icon name="layout-grid" size={18} />}
              kicker="Entity"
              title="Reusable Detail Header"
              meta={<><span class="pane-row-mono">WL-DS</span><span class="pane-row-dot">·</span><span>Responsive</span></>}
              actions={<><Button variant="ghost">Cancel</Button><Button variant="primary">Save</Button></>}
            />
            <div class="pane-detail-body entity-detail-body">
              <EntityEditorLayout
                main={(
                  <>
                    <Card title="Main Surface">
                      <p class="soft-meta">Entity editors use this grid before route-specific fields are added.</p>
                    </Card>
                    <Card title="Nested Surface">
                      <p class="soft-meta">Panels stay shallow, rectangular, and tokenized.</p>
                    </Card>
                  </>
                )}
                rail={(
                  <RailStack>
                    <Card title="Rail Card" class="entity-rail-card">Runtime metadata</Card>
                    <Card title="Actions" class="entity-rail-card">Secondary controls</Card>
                  </RailStack>
                )}
              />
            </div>
          </div>
        </section>

        <section class="ds-catalog-section">
          <Card title="Workflow Layout">
            <WorkflowLayout
              hero={<DetailHeader icon={<Icon name="clock" size={16} />} title="Scheduled Work" meta="Primary action first" actions={<Button variant="primary">Run</Button>} />}
              main={<InlineEditorPanel title="Inline editor" description="Appears only after the user chooses to edit."><ScheduleBuilder value={schedule} onChange={setSchedule} /></InlineEditorPanel>}
              rail={<RailStack><Card title="Context">Only persistent context belongs in the rail.</Card><Card collapsible={{ summary: "Advanced", count: 2 }}>Rare actions stay collapsed.</Card></RailStack>}
            />
          </Card>
        </section>
      </Page>
    </AppShell>
  );
}
