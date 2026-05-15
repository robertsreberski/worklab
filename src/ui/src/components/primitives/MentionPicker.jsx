// §3.x MentionPicker — typeahead dropdown for cross-entity mentions.
// Anchored just below an input/textarea, fed by `/api/mentions/search`,
// and driven by ArrowUp/Down + Enter via the parent component (so the
// textarea retains focus while the picker is open). The keyboard
// navigation logic mirrors §3.6 Select.

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "preact/hooks";
import { forwardRef } from "preact/compat";
import { api } from "../../lib/api.js";
import { useDropdownPlacement } from "../../hooks/useDropdownPlacement.js";
import { PopoverPortal } from "./PopoverPortal.jsx";
import { entityBadgeMeta } from "../../lib/entityBadges.js";
import { MENTION_TYPES } from "../../lib/mentions.js";
import { Icon } from "../Icon.jsx";

const TYPE_BADGE = {
  agent: "Agent",
  task: "Task",
  project: "Project",
  team: "Team",
  kb: "Knowledge",
  skill: "Skill",
  goal: "Goal",
  run: "Run",
};

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

function normaliseTypeFilter(types) {
  if (!types) return [];
  const input = Array.isArray(types) ? types : String(types).split(",");
  return input
    .map((type) => String(type || "").trim().toLowerCase())
    .filter((type) => MENTION_TYPES.includes(type));
}

export function mentionPickerRequest(query, types) {
  const raw = String(query || "").trim();
  const allowedTypes = normaliseTypeFilter(types);
  const typed = /^([A-Za-z0-9_-]+)\/(.*)$/.exec(raw);
  if (typed) {
    const type = typed[1].toLowerCase();
    if (!MENTION_TYPES.includes(type)) return null;
    if (allowedTypes.length && !allowedTypes.includes(type)) return null;
    return { q: typed[2], types: type };
  }
  if (!raw) return null;
  const request = { q: raw };
  if (allowedTypes.length) request.types = Array.isArray(types) ? allowedTypes : allowedTypes.join(",");
  return request;
}

export function mentionPickerResults(results) {
  return Array.isArray(results) ? results : [];
}

function TypeBadgeMarker({ type }) {
  const meta = entityBadgeMeta(type);
  if (meta.icon) {
    return (
      <span class="badge-token-leading" aria-hidden="true">
        <Icon name={meta.icon} class="badge-token-icon" size={12} />
      </span>
    );
  }
  if (meta.glyph) {
    return <span class="badge-token-glyph" aria-hidden="true">{meta.glyph}</span>;
  }
  return null;
}

export const MentionPicker = forwardRef(function MentionPicker(
  { open, query, types, onSelect, onClose, anchorRef },
  ref,
) {
  const [results, setResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const fetchAbort = useRef(null);
  const seqRef = useRef(0);
  const popoverRef = useRef(null);
  // Always pair MentionPicker with an explicit anchorRef — once portaled, the
  // popover's parentElement is <body>, so the hook's fallback can no longer
  // recover the textarea wrapper.
  const { placement, maxHeight, top, left, width, ready } = useDropdownPlacement(anchorRef, popoverRef, open);

  // Keep the picker keyboard-controlled by the parent textarea so
  // focus stays in the editor while navigating.
  const visibleResults = mentionPickerResults(results);

  useImperativeHandle(ref, () => ({
    moveDown: () => setActiveIndex((i) => (visibleResults.length ? (i + 1) % visibleResults.length : 0)),
    moveUp: () => setActiveIndex((i) => (visibleResults.length ? (i - 1 + visibleResults.length) % visibleResults.length : 0)),
    selectActive: () => {
      const item = visibleResults[activeIndex];
      if (item) onSelect?.(item);
    },
    hasResults: () => visibleResults.length > 0,
  }), [visibleResults, activeIndex, onSelect]);

  const fetchResults = useMemo(() => debounce(async (q, typeFilter, seq) => {
    const request = mentionPickerRequest(q, typeFilter);
    if (!request) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (fetchAbort.current) fetchAbort.current.abort();
    const ctrl = new AbortController();
    fetchAbort.current = ctrl;
    try {
      const params = { ...request, limit: 8 };
      const res = await api.searchMentions(params, { signal: ctrl.signal });
      if (seq !== seqRef.current) return;
      setResults(res?.results || []);
      setActiveIndex(0);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setResults([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, 120), []);

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
    fetchResults(query?.trim() || "", types, seqRef.current);
  }, [open, query, types, fetchResults]);

  useEffect(() => () => fetchResults.cancel(), [fetchResults]);

  if (!open) return null;

  return (
    <PopoverPortal>
    <div
      ref={popoverRef}
      class="mention-picker"
      role="listbox"
      aria-label="Mention candidates"
      data-placement={placement}
      style={{
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        visibility: ready ? "visible" : "hidden",
        ...(maxHeight != null ? { "--placement-max-height": `${maxHeight}px` } : {}),
      }}
    >
      {loading && results.length === 0 && (
        <div class="mention-picker-empty">Searching…</div>
      )}
      {!loading && results.length === 0 && (
        <div class="mention-picker-empty">No matches</div>
      )}
      {visibleResults.map((item, idx) => {
        const active = idx === activeIndex;
        return (
          <div
            key={item.token}
            class={`mention-picker-option ${active ? "active" : ""}`}
            role="option"
            aria-selected={active}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect?.(item);
            }}
            onMouseEnter={() => setActiveIndex(idx)}
          >
            <span class={`mention-picker-type badge-token badge-token-xs entity-badge entity-badge--${item.type}`} data-kind={item.type}>
              <TypeBadgeMarker type={item.type} />
              <span class="badge-token-label">
              {TYPE_BADGE[item.type] || item.type}
              </span>
            </span>
            <span class="mention-picker-body">
              <span class="mention-picker-label">{item.label}</span>
              {item.sublabel && <span class="mention-picker-sublabel">{item.sublabel}</span>}
            </span>
            <span class="mention-picker-token">{item.token}</span>
          </div>
        );
      })}
      {onClose && (
        <button
          type="button"
          class="visually-hidden"
          onClick={() => onClose?.()}
          aria-label="Close mention picker"
        />
      )}
    </div>
    </PopoverPortal>
  );
});
