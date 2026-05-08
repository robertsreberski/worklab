import { Icon } from "../../components/Icon.jsx";
import { StatusPill } from "../../components/primitives/StatusPill.jsx";

export function FieldNote({ label, value, mono = false }) {
  return (
    <div class="settings-note">
      <span>{label}</span>
      <strong class={mono ? "mono" : ""}>{value || "-"}</strong>
    </div>
  );
}

export function SettingsOverviewCard({
  icon,
  title,
  value,
  detail,
  status,
  statusLabel,
  targetId,
  active = false,
  onSelect,
}) {
  const content = (
    <>
      <div class="settings-overview-icon"><Icon name={icon} size={18} /></div>
      <div class="settings-overview-copy">
        <span>{title}</span>
        <strong>{value || "-"}</strong>
        {detail && <small>{detail}</small>}
      </div>
      {status && <StatusPill status={status} label={statusLabel} size="sm" />}
    </>
  );
  if (targetId || onSelect) {
    return (
      <button
        type="button"
        class={`settings-overview-card ${active ? "is-active" : ""}`.trim()}
        aria-current={active ? "location" : undefined}
        onClick={() => onSelect?.(targetId)}
      >
        {content}
      </button>
    );
  }
  return (
    <div class={`settings-overview-card ${active ? "is-active" : ""}`.trim()}>{content}</div>
  );
}

export function SettingsSection({ id, kicker, title, description, aside, children }) {
  return (
    <section id={id} class="settings-section-shell">
      <header class="settings-section-head">
        <div class="settings-section-copy">
          {kicker && <span class="form-section-kicker">{kicker}</span>}
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </div>
        {aside && <div class="settings-section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function SettingPanel({ icon, title, meta, status, statusLabel, children, class: className = "" }) {
  return (
    <div class={`settings-panel ${className}`.trim()}>
      <header class="settings-panel-head">
        <div class="settings-panel-title">
          {icon && <span class="settings-panel-icon"><Icon name={icon} size={16} /></span>}
          <div>
            <h3>{title}</h3>
            {meta && <p>{meta}</p>}
          </div>
        </div>
        {status && <StatusPill status={status} label={statusLabel} size="sm" />}
      </header>
      <div class="settings-panel-body">{children}</div>
    </div>
  );
}

export function AdvancedSettings({ summary, count, defaultOpen = false, children }) {
  return (
    <details class="settings-advanced" open={defaultOpen}>
      <summary>
        <span>{summary}</span>
        {typeof count === "number" && <em>{count}</em>}
      </summary>
      <div class="settings-advanced-body">{children}</div>
    </details>
  );
}
