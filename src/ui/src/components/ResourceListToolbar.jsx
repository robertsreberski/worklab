import { Button, SearchField } from "./primitives/index.js";
import { Icon } from "./Icon.jsx";

export function ResourceListToolbar({
  searchValue,
  onSearch,
  searchPlaceholder,
  searchAriaLabel,
  searchRef,
  countLabel,
  actionLabel,
  onAction,
  actionIcon = "plus",
  children,
}) {
  return (
    <div class="resource-toolbar">
      <SearchField
        value={searchValue}
        onInput={(event) => onSearch?.(event.target.value, event)}
        placeholder={searchPlaceholder}
        ariaLabel={searchAriaLabel}
        shortcut="/"
        inputRef={searchRef}
      />
      {children && <div class="resource-toolbar-filters">{children}</div>}
      <div class="resource-toolbar-actions">
        {countLabel && <span class="resource-toolbar-count">{countLabel}</span>}
        {actionLabel && (
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name={actionIcon} size={12} />}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ResourceGroup({ group, children }) {
  return (
    <div class="resource-group">
      <div class="resource-group-header">
        <span>{group.label}</span>
        <span class="resource-group-count">{group.items?.length || 0}</span>
      </div>
      {children}
    </div>
  );
}
