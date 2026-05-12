import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "preact/hooks";
import { forwardRef } from "preact/compat";
import { api } from "../lib/api.js";
import { useDropdownPlacement } from "../hooks/useDropdownPlacement.js";
import { PopoverPortal } from "./primitives/PopoverPortal.jsx";

function debounce(fn, delay) {
  let timer = null;
  let pending = null;
  const wrapped = (...args) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      fn(...next);
    }, delay);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; pending = null; } };
  return wrapped;
}

export const PathPicker = forwardRef(function PathPicker(
  { open, prefix, context = {}, onSelect, onClose, anchorRef },
  ref,
) {
  const [results, setResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const fetchAbort = useRef(null);
  const seqRef = useRef(0);
  const popoverRef = useRef(null);
  const { placement, maxHeight, top, left, width, ready } = useDropdownPlacement(anchorRef, popoverRef, open);

  useImperativeHandle(ref, () => ({
    moveDown: () => setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0)),
    moveUp: () => setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0)),
    selectActive: () => {
      const item = results[activeIndex];
      if (item) onSelect?.(item);
    },
    hasResults: () => results.length > 0,
  }), [results, activeIndex, onSelect]);

  const fetchResults = useMemo(() => debounce(async (q, ctx, seq) => {
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (fetchAbort.current) fetchAbort.current.abort();
    const ctrl = new AbortController();
    fetchAbort.current = ctrl;
    try {
      const params = { prefix: q, limit: 10 };
      if (ctx?.taskId) params.task_id = ctx.taskId;
      if (ctx?.projectId) params.project_id = ctx.projectId;
      const res = await api.suggestFiles(params, { signal: ctrl.signal });
      if (seq !== seqRef.current) return;
      setResults(res?.results || []);
      setActiveIndex(0);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setResults([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, 100), []);

  useEffect(() => {
    if (!open) {
      fetchResults.cancel();
      if (fetchAbort.current) { fetchAbort.current.abort(); fetchAbort.current = null; }
      setResults([]);
      setActiveIndex(0);
      setLoading(false);
      return;
    }
    seqRef.current += 1;
    fetchResults(prefix || "", context || {}, seqRef.current);
  }, [open, prefix, context?.taskId, context?.projectId, fetchResults]);

  useEffect(() => () => fetchResults.cancel(), [fetchResults]);

  if (!open) return null;

  return (
    <PopoverPortal>
      <div
        ref={popoverRef}
        class="mention-picker path-picker"
        role="listbox"
        aria-label="Path suggestions"
        data-placement={placement}
        style={{
          top: `${top}px`,
          left: `${left}px`,
          width: `${width}px`,
          visibility: ready ? "visible" : "hidden",
          ...(maxHeight != null ? { "--placement-max-height": `${maxHeight}px` } : {}),
        }}
      >
        {loading && results.length === 0 && <div class="mention-picker-empty">Searching paths...</div>}
        {!loading && results.length === 0 && <div class="mention-picker-empty">No path matches</div>}
        {results.map((item, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={item.path}
              class={`mention-picker-option ${active ? "active" : ""}`}
              role="option"
              aria-selected={active}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect?.(item);
              }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              <span class="mention-picker-type chip-mention chip-mention--path">
                {item.kind === "directory" ? "Folder" : "File"}
              </span>
              <span class="mention-picker-body">
                <span class="mention-picker-label">{item.name}</span>
                {item.absolute_path && <span class="mention-picker-sublabel">{item.absolute_path}</span>}
              </span>
              <span class="mention-picker-token">{item.path}</span>
            </div>
          );
        })}
        {onClose && (
          <button type="button" class="visually-hidden" onClick={() => onClose?.()} aria-label="Close path picker" />
        )}
      </div>
    </PopoverPortal>
  );
});
