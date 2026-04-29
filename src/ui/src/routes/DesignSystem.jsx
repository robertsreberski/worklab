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
  Divider,
  IconButton,
  Input,
  Kbd,
  RadioGroup,
  SearchField,
  Select,
  StatusDot,
  StatusPill,
  Switch,
  Tabs,
  Textarea,
  Tooltip,
} from "../components/primitives/index.js";
import {
  DetailHeader,
  EntityEditorLayout,
  Page,
  PanelGrid,
  RailStack,
  SummaryGrid,
  Toolbar,
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
              <Card title="Rows">
                <PaneRow
                  title="Retro console migration"
                  leading={<AgentAvatar name="design-system" label="Design System" />}
                  sub={<span class="pane-row-description">Reusable row pattern with leading identity, title, meta, and status.</span>}
                  trailing={<StatusPill status="review" />}
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
      </Page>
    </AppShell>
  );
}
