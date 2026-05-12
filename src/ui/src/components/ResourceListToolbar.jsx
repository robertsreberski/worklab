import { useState } from "preact/hooks";
import { Button, SearchField } from "./primitives/index.js";
import { Icon } from "./Icon.jsx";
import { MobileConfigSheet, MobileConfigTrigger } from "./MobileConfigSheet.jsx";
import { SectionGroup, Toolbar } from "./layout/index.js";

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
  scopeTabs = null,
  children,
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const configId = `resource-config-${configTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list"}`;

  return (
    <div class="resource-toolbar resource-toolbar-compact">
      {scopeTabs && <div class="resource-toolbar-scope-tabs">{scopeTabs}</div>}
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
      <Toolbar class="resource-toolbar-actions">
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
      </Toolbar>
      {actionLabel && (
        <Button
          class="resource-list-fab"
          variant="primary"
          iconLeft={<Icon name={actionIcon} size={22} />}
          aria-label={actionLabel}
          title={actionLabel}
          onClick={onAction}
        />
      )}
    </div>
  );
}

export function ResourceList({ children, class: className = "", ...props }) {
  return <div {...props} class={`resource-list ${className}`.trim()}>{children}</div>;
}

export function ResourceGroup({ group, children }) {
  if (group.showHeader === false) {
    return <div class="ds-section-group resource-group">{children}</div>;
  }
  return (
    <SectionGroup
      as="div"
      class="resource-group"
      label={group.label}
      count={group.items?.length || 0}
    >
      {children}
    </SectionGroup>
  );
}
