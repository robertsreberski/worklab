import { Icon } from "../Icon.jsx";
import { Button, SearchField } from "../primitives/index.js";

export function PaneListHeader({
  searchValue,
  onSearch,
  searchPlaceholder,
  searchAriaLabel,
  searchRef,
  actionLabel,
  onAction,
  actionIcon = "plus",
  children,
}) {
  return (
    <>
      <SearchField
        value={searchValue}
        onInput={(event) => onSearch?.(event.target.value, event)}
        placeholder={searchPlaceholder}
        ariaLabel={searchAriaLabel}
        inputRef={searchRef}
      />
      {children}
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
    </>
  );
}
