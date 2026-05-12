// Drop-in replacement for <Textarea> that opens a MentionPicker when
// the user types `@`. Keyboard navigation (arrow up/down, enter,
// escape) is forwarded to the picker while it's open; otherwise the
// textarea behaves like any other native control.
//
// Usage:
//   <MentionableTextarea
//     value={value}
//     onInput={(e) => setValue(e.currentTarget.value)}
//     types={["agent", "task"]} // optional — defaults to all
//   />

import { useCallback, useRef, useState } from "preact/hooks";
import { Textarea } from "./primitives/Textarea.jsx";
import { MentionPicker } from "./primitives/MentionPicker.jsx";
import { PathPicker } from "./PathPicker.jsx";
import { findMentionTrigger } from "../lib/mentions.js";
import { findPathTrigger, insertPathSuggestion } from "../lib/pathReferences.js";

export function MentionableTextarea({
  value,
  onInput,
  onChange,
  onKeyDown,
  types,
  pathContext,
  inputRef,
  ...rest
}) {
  const containerRef = useRef(null);
  const pickerRef = useRef(null);
  const pathPickerRef = useRef(null);
  const localTextareaRef = useRef(null);
  const [trigger, setTrigger] = useState(null);
  const [pathTrigger, setPathTrigger] = useState(null);

  const setTextareaRef = useCallback((node) => {
    localTextareaRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef && typeof inputRef === "object") inputRef.current = node;
  }, [inputRef]);

  function getTextarea() {
    return localTextareaRef.current
      || containerRef.current?.querySelector("textarea")
      || null;
  }

  const measureTrigger = useCallback((textarea) => {
    if (!textarea) return null;
    const next = findMentionTrigger(textarea.value, textarea.selectionStart);
    setTrigger(next);
    setPathTrigger(next ? null : findPathTrigger(textarea.value, textarea.selectionStart));
    return next;
  }, []);

  const closePicker = useCallback(() => {
    setTrigger(null);
    setPathTrigger(null);
  }, []);

  const insertMention = useCallback((mention) => {
    const textarea = getTextarea();
    if (!textarea) return;
    const current = trigger || findMentionTrigger(textarea.value, textarea.selectionStart);
    if (!current) return;
    const text = textarea.value;
    const before = text.slice(0, current.start);
    const after = text.slice(current.end);
    const insertion = `${mention.token} `;
    const nextValue = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    // Drive the textarea via the standard input event so consumers
    // (controlled inputs in Preact) receive the change exactly as if
    // the user typed it.
    textarea.value = nextValue;
    textarea.setSelectionRange(caret, caret);
    const event = new InputEvent("input", { bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    setTrigger(null);
  }, [trigger]);

  const insertPath = useCallback((suggestion) => {
    const textarea = getTextarea();
    if (!textarea) return;
    const current = pathTrigger || findPathTrigger(textarea.value, textarea.selectionStart);
    if (!current) return;
    const next = insertPathSuggestion(textarea.value, current, suggestion);
    textarea.value = next.value;
    textarea.setSelectionRange(next.caret, next.caret);
    const event = new InputEvent("input", { bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    if (suggestion?.kind === "directory") {
      setPathTrigger(findPathTrigger(textarea.value, textarea.selectionStart));
    } else {
      setPathTrigger(null);
    }
  }, [pathTrigger]);

  const handleInput = useCallback((event) => {
    onInput?.(event);
    measureTrigger(event.currentTarget);
  }, [onInput, measureTrigger]);

  const handleKeyDown = useCallback((event) => {
    if (trigger && pickerRef.current) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        pickerRef.current.moveDown();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        pickerRef.current.moveUp();
        return;
      }
      if (event.key === "Enter") {
        if (pickerRef.current.hasResults()) {
          event.preventDefault();
          pickerRef.current.selectActive();
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
        return;
      }
    }
    if (pathTrigger && pathPickerRef.current) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        pathPickerRef.current.moveDown();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        pathPickerRef.current.moveUp();
        return;
      }
      if (event.key === "Enter") {
        if (pathPickerRef.current.hasResults()) {
          event.preventDefault();
          pathPickerRef.current.selectActive();
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
        return;
      }
    }
    onKeyDown?.(event);
  }, [trigger, pathTrigger, onKeyDown, closePicker]);

  const handleSelect = useCallback((event) => {
    measureTrigger(event.currentTarget);
  }, [measureTrigger]);

  const handleBlur = useCallback(() => {
    // Defer close so a click on a picker option still fires.
    setTimeout(() => {
      setTrigger(null);
      setPathTrigger(null);
    }, 120);
  }, []);

  return (
    <div class="mentionable" ref={containerRef}>
      <Textarea
        {...rest}
        inputRef={setTextareaRef}
        value={value}
        onInput={handleInput}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onClick={handleSelect}
        onBlur={handleBlur}
      />
      <MentionPicker
        ref={pickerRef}
        open={!!trigger}
        query={trigger?.query || ""}
        types={types}
        anchorRef={containerRef}
        onSelect={insertMention}
        onClose={closePicker}
      />
      <PathPicker
        ref={pathPickerRef}
        open={!!pathTrigger}
        prefix={pathTrigger?.prefix || ""}
        context={pathContext}
        anchorRef={containerRef}
        onSelect={insertPath}
        onClose={closePicker}
      />
    </div>
  );
}
