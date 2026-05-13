import { useCallback, useRef, useState } from "preact/hooks";
import { Input } from "./primitives/Input.jsx";
import { PathPicker } from "./PathPicker.jsx";
import { findPathTrigger, insertPathSuggestion } from "../lib/pathReferences.js";

export function PathSuggestInput({
  value,
  onInput,
  onChange,
  onKeyDown,
  pathContext,
  inputRef,
  preferAbsoluteSelection = false,
  ...rest
}) {
  const containerRef = useRef(null);
  const pickerRef = useRef(null);
  const localInputRef = useRef(null);
  const [pathTrigger, setPathTrigger] = useState(null);

  const setInputRef = useCallback((node) => {
    localInputRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef && typeof inputRef === "object") inputRef.current = node;
  }, [inputRef]);

  function getInput() {
    return localInputRef.current
      || containerRef.current?.querySelector("input")
      || null;
  }

  const measureTrigger = useCallback((input) => {
    if (!input) return null;
    const next = findPathTrigger(input.value, input.selectionStart);
    setPathTrigger(next);
    return next;
  }, []);

  const closePicker = useCallback(() => {
    setPathTrigger(null);
  }, []);

  const insertPath = useCallback((suggestion) => {
    const input = getInput();
    if (!input) return;
    const current = pathTrigger || findPathTrigger(input.value, input.selectionStart);
    if (!current) return;
    const next = insertPathSuggestion(input.value, current, suggestion, {
      preferAbsolute: preferAbsoluteSelection,
    });
    input.value = next.value;
    input.setSelectionRange(next.caret, next.caret);
    const event = new InputEvent("input", { bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    if (suggestion?.kind === "directory" && !preferAbsoluteSelection) {
      setPathTrigger(findPathTrigger(input.value, input.selectionStart));
    } else {
      setPathTrigger(null);
    }
  }, [pathTrigger, preferAbsoluteSelection]);

  const handleInput = useCallback((event) => {
    onInput?.(event);
    measureTrigger(event.currentTarget);
  }, [onInput, measureTrigger]);

  const handleKeyDown = useCallback((event) => {
    if (pathTrigger && pickerRef.current) {
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
    onKeyDown?.(event);
  }, [pathTrigger, onKeyDown, closePicker]);

  const handleSelect = useCallback((event) => {
    measureTrigger(event.currentTarget);
  }, [measureTrigger]);

  const handleBlur = useCallback(() => {
    setTimeout(() => {
      setPathTrigger(null);
    }, 120);
  }, []);

  return (
    <div class="path-suggest-input" ref={containerRef}>
      <Input
        {...rest}
        inputRef={setInputRef}
        value={value}
        onInput={handleInput}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onClick={handleSelect}
        onBlur={handleBlur}
      />
      <PathPicker
        ref={pickerRef}
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
