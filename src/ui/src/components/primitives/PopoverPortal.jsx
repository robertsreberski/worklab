// Mounts popover content into document.body so it escapes any clipping
// ancestor (overflow:hidden) or stacking-context trap (transform/filter)
// in the trigger's subtree. Pair with `position: fixed` and viewport-
// relative coords from `useDropdownPlacement`.

import { createPortal } from "preact/compat";

export function PopoverPortal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
