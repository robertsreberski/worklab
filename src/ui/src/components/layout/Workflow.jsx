import { Button } from "../primitives/Button.jsx";
import { SearchField } from "../primitives/SearchField.jsx";
import { Toolbar } from "./Page.jsx";

export function FilterBar({
  searchValue,
  onSearch,
  searchPlaceholder = "Search...",
  searchAriaLabel = "Search",
  filters,
  presets,
  actions,
  activeCount = 0,
  onClear,
  class: className = "",
}) {
  return (
    <div class={`filter-bar ${className}`.trim()}>
      {onSearch && (
        <SearchField
          value={searchValue || ""}
          onInput={(event) => onSearch(event.currentTarget.value)}
          placeholder={searchPlaceholder}
          ariaLabel={searchAriaLabel}
          class="filter-bar-search"
        />
      )}
      {filters && <div class="filter-bar-filters">{filters}</div>}
      {presets && <div class="filter-bar-presets">{presets}</div>}
      <Toolbar class="filter-bar-actions">
        {activeCount > 0 && <span class="filter-bar-count">{activeCount} active</span>}
        {activeCount > 0 && onClear && <Button size="sm" variant="ghost" onClick={onClear}>Reset</Button>}
        {actions}
      </Toolbar>
    </div>
  );
}

export function ActionDock({
  primary,
  secondary,
  overflow,
  class: className = "",
}) {
  return (
    <div class={`action-dock ${className}`.trim()}>
      {secondary && <div class="action-dock-secondary">{secondary}</div>}
      {overflow && <div class="action-dock-overflow">{overflow}</div>}
      {primary && <div class="action-dock-primary">{primary}</div>}
    </div>
  );
}

export function WorkflowLayout({
  hero,
  main,
  rail,
  class: className = "",
}) {
  return (
    <div class={`workflow-layout ${className}`.trim()}>
      {hero && <section class="workflow-hero">{hero}</section>}
      <main class="workflow-main">{main}</main>
      {rail && <aside class="workflow-rail">{rail}</aside>}
    </div>
  );
}

export function InlineEditorPanel({
  title,
  description,
  actions,
  children,
  class: className = "",
}) {
  return (
    <section class={`inline-editor-panel ${className}`.trim()}>
      {(title || description || actions) && (
        <header class="inline-editor-panel-head">
          <div>
            {title && <h4>{title}</h4>}
            {description && <p>{description}</p>}
          </div>
          {actions && <Toolbar class="inline-editor-panel-actions">{actions}</Toolbar>}
        </header>
      )}
      <div class="inline-editor-panel-body">{children}</div>
    </section>
  );
}

export function SettingsMatrix({ children, class: className = "" }) {
  return <div class={`settings-matrix ${className}`.trim()}>{children}</div>;
}
