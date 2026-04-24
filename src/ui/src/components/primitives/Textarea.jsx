// §3.4 Textarea — multi-line text. monospace + autoGrow options.
import { useEffect, useRef } from "preact/hooks";

export function Textarea({
  value,
  onInput,
  onChange,
  rows = 5,
  monospace = false,
  autoGrow = false,
  placeholder,
  disabled,
  readOnly,
  class: className = "",
  ...rest
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!autoGrow || !ref.current) return;
    const el = ref.current;
    el.style.height = "auto";
    const max = Math.floor(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value, autoGrow]);

  const cls = `textarea ${monospace ? "mono" : ""} ${className}`.trim();
  return (
    <textarea
      ref={ref}
      class={cls}
      rows={rows}
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      onInput={(e) => { onInput?.(e); }}
      onChange={onChange}
      {...rest}
    />
  );
}
