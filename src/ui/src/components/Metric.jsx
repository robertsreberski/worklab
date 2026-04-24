// §4.8 Metric — single numeric measurement with kicker label.
export function Metric({ label, value, unit, trend, class: className = "" }) {
  return (
    <div class={`metric ${className}`.trim()}>
      <span class="label">{label}</span>
      <span class="value">
        {value}
        {unit && <span class="unit">{unit}</span>}
        {trend}
      </span>
    </div>
  );
}
