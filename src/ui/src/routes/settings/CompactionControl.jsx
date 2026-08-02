import { FormField } from "../../components/FormField.jsx";
import { ControlGroup } from "../../components/layout/index.js";
import { Button, NumberStepper } from "../../components/primitives/index.js";
import {
  COMPACTION_OVERRIDE_KEYS,
  compactionIsAdaptive,
} from "./helpers.js";

export function CompactionControl({ settings, onChange }) {
  const adaptive = compactionIsAdaptive(settings);
  const updateSetting = (key, value) => onChange({
    ...settings,
    [key]: value === "" ? null : value,
  });
  const clearOverrides = () => onChange({
    ...settings,
    ...Object.fromEntries(COMPACTION_OVERRIDE_KEYS.map((key) => [key, null])),
  });

  return (
    <ControlGroup title="Context compaction" description="Leave a field blank to scale it to each model's context window. Enter a number to pin only that limit.">
      <FormField label="Trigger ratio" hint="Adaptive when blank.">
        <NumberStepper min={0.2} max={0.95} step={0.01} value={settings.agent_compaction_trigger_ratio ?? ""} ariaLabel="Compaction trigger ratio" onChange={(value) => updateSetting("agent_compaction_trigger_ratio", value)} />
      </FormField>
      <FormField label="Keep tokens" hint="Adaptive when blank.">
        <NumberStepper min={4000} max={200000} step={1000} value={settings.agent_compaction_keep_recent_tokens ?? ""} ariaLabel="Keep recent tokens" onChange={(value) => updateSetting("agent_compaction_keep_recent_tokens", value)} />
      </FormField>
      <FormField label="Summary tokens" hint="Adaptive when blank.">
        <NumberStepper min={1000} max={64000} step={1000} value={settings.agent_compaction_summary_max_tokens ?? ""} ariaLabel="Compaction summary tokens" onChange={(value) => updateSetting("agent_compaction_summary_max_tokens", value)} />
      </FormField>
      <FormField label="Min savings" hint="Adaptive when blank.">
        <NumberStepper min={0} max={500000} step={1000} value={settings.agent_compaction_min_savings_tokens ?? ""} ariaLabel="Minimum compaction savings tokens" onChange={(value) => updateSetting("agent_compaction_min_savings_tokens", value)} />
      </FormField>
      <div class="span-2">
        <Button size="sm" variant="ghost" disabled={adaptive} onClick={clearOverrides}>
          Reset all to adaptive
        </Button>
      </div>
    </ControlGroup>
  );
}
