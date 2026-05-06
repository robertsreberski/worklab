import { useState } from "preact/hooks";
import { Button, SearchField } from "./primitives/index.js";
import { Icon } from "./Icon.jsx";
import { MobileConfigSheet, MobileConfigTrigger } from "./MobileConfigSheet.jsx";

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
  configTitle = "List configuration",
  activeConfigCount = 0,
  children,
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const configId = `resource-config-${configTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list"}`;

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
      {children && (
        <>
          <MobileConfigTrigger
            class="resource-mobile-config-trigger"
            label={configTitle}
            controls={configId}
            expanded={configOpen}
            activeCount={activeConfigCount}
            onClick={() => setConfigOpen(true)}
          />
          <MobileConfigSheet
            id={configId}
            title={configTitle}
            open={configOpen}
            onClose={() => setConfigOpen(false)}
            class="resource-toolbar-config"
            bodyClass="resource-toolbar-filters"
          >
            {children}
          </MobileConfigSheet>
        </>
      )}
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
