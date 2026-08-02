import { FormField } from "../../components/FormField.jsx";
import { ControlGroup } from "../../components/layout/index.js";
import { NumberStepper } from "../../components/primitives/index.js";
import { Switch } from "../../components/primitives/Switch.jsx";
import {
  COMPACTION_OVERRIDE_KEYS,
  COMPACTION_OVERRIDE_SEED,
  compactionIsAdaptive,
} from "./helpers.js";

export function CompactionControl({ settings, onChange }) {
  const adaptive = compactionIsAdaptive(settings);
  const updateSetting = (key, value) => onChange({ ...settings, [key]: value });

  return (
    <ControlGroup title="Context compaction" description="Transcript compaction trigger and retained context size.">
      <Switch
        checked={adaptive}
        onChange={(value) => onChange({
          ...settings,
          ...(value
            ? Object.fromEntries(COMPACTION_OVERRIDE_KEYS.map((key) => [key, null]))
            : COMPACTION_OVERRIDE_SEED),
        })}
        label="Adaptive"
        description="Scale the limits to each model's context window. Turn off to pin fixed values."
      />
      {!adaptive && (
        <>
          <FormField label="Trigger ratio">
            <NumberStepper min={0.2} max={0.95} step={0.01} value={settings.agent_compaction_trigger_ratio ?? COMPACTION_OVERRIDE_SEED.agent_compaction_trigger_ratio} ariaLabel="Compaction trigger ratio" onChange={(value) => updateSetting("agent_compaction_trigger_ratio", value)} />
          </FormField>
          <FormField label="Keep tokens">
            <NumberStepper min={4000} max={200000} step={1000} value={settings.agent_compaction_keep_recent_tokens ?? COMPACTION_OVERRIDE_SEED.agent_compaction_keep_recent_tokens} ariaLabel="Keep recent tokens" onChange={(value) => updateSetting("agent_compaction_keep_recent_tokens", value)} />
          </FormField>
          <FormField label="Summary tokens">
            <NumberStepper min={1000} max={64000} step={1000} value={settings.agent_compaction_summary_max_tokens ?? COMPACTION_OVERRIDE_SEED.agent_compaction_summary_max_tokens} ariaLabel="Compaction summary tokens" onChange={(value) => updateSetting("agent_compaction_summary_max_tokens", value)} />
          </FormField>
          <FormField label="Min savings">
            <NumberStepper min={0} max={500000} step={1000} value={settings.agent_compaction_min_savings_tokens ?? COMPACTION_OVERRIDE_SEED.agent_compaction_min_savings_tokens} ariaLabel="Minimum compaction savings tokens" onChange={(value) => updateSetting("agent_compaction_min_savings_tokens", value)} />
          </FormField>
        </>
      )}
    </ControlGroup>
  );
}
