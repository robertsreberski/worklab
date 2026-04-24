// §4.5 PaneLayout — left list + right detail. URL-synced by hash router.
// Collapses to single-pane with back button below 860px.

import { useEffect, useState } from "preact/hooks";
import { Button } from "./primitives/Button.jsx";
import { Icon } from "./Icon.jsx";

export function PaneLayout({
  listHeader,
  listBody,
  detail,
  hasSelection = false,
  onBack,
  backLabel = "Back",
  class: className = "",
}) {
  const [compactView, setCompactView] = useState(
    typeof window !== "undefined" ? window.innerWidth < 860 : false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 860px)");
    if (!mq) return;
    const onChange = () => setCompactView(mq.matches);
    mq.addEventListener?.("change", onChange);
    setCompactView(mq.matches);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  if (compactView) {
    // Single-pane mode: show list, or detail if selected
    return (
      <div class={`two-pane two-pane-compact ${className}`.trim()}>
        {hasSelection ? (
          <div class="pane-detail pane-detail-compact">
            {onBack && (
              <div class="pane-mobile-back">
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft={<Icon name="chevron-left" size={13} />}
                  onClick={onBack}
                >
                  {backLabel}
                </Button>
              </div>
            )}
            {detail}
          </div>
        ) : (
          <div class="pane-list">
            <div class="pane-list-head">{listHeader}</div>
            <div class="pane-list-body">{listBody}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div class={`two-pane ${className}`.trim()}>
      <aside class="pane-list">
        {listHeader && <div class="pane-list-head">{listHeader}</div>}
        <div class="pane-list-body">{listBody}</div>
      </aside>
      <section class="pane-detail">{detail}</section>
    </div>
  );
}
