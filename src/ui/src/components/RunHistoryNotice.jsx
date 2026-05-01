import { Button } from "./primitives/Button.jsx";

export function RunHistoryNotice({
  eventCount = 0,
  visibleCount = 0,
  eventsTruncated = false,
  fullHistoryLoaded = false,
  loading = false,
  onLoadFullHistory,
  rawLogHref = null,
}) {
  const total = Number(eventCount || 0);
  const visible = Number(visibleCount || 0);
  const hasHiddenHistory = Boolean(eventsTruncated && total > visible);
  const showLoadedState = Boolean(fullHistoryLoaded && total > 0);

  if (!hasHiddenHistory && !rawLogHref && !showLoadedState) return null;

  return (
    <div class="run-history-notice">
      <span class="run-history-copy">
        {hasHiddenHistory
          ? "Showing latest logs"
          : showLoadedState
            ? "Full history loaded"
            : "Run log"}
      </span>
      <span class="run-history-actions">
        {hasHiddenHistory && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={loading}
            disabled={typeof onLoadFullHistory !== "function"}
            onClick={onLoadFullHistory}
            aria-label="Load full history"
          >
            Load full history
          </Button>
        )}
        {rawLogHref && (
          <a class="run-history-link" href={rawLogHref} target="_blank" rel="noreferrer">
            Raw log
          </a>
        )}
      </span>
    </div>
  );
}
