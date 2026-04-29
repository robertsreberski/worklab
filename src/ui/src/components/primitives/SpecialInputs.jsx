import { useMemo, useState } from "preact/hooks";
import { Icon } from "../Icon.jsx";
import { Button } from "./Button.jsx";
import { IconButton } from "./IconButton.jsx";
import { Input } from "./Input.jsx";
import { Textarea } from "./Textarea.jsx";

export function SecretInput({
  value,
  onInput,
  placeholder,
  disabled,
  autocomplete,
  class: className = "",
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div class={`secret-input ${className}`.trim()}>
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onInput={onInput}
        placeholder={placeholder}
        disabled={disabled}
        autocomplete={autocomplete}
      />
      <IconButton
        size="sm"
        aria-label={visible ? "Hide secret" : "Show secret"}
        icon={<Icon name={visible ? "eye-off" : "eye"} size={13} />}
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        class="secret-input-toggle"
      />
    </div>
  );
}

export function JsonField({
  value,
  onInput,
  rows = 4,
  disabled,
  placeholder,
  class: className = "",
}) {
  const error = useMemo(() => {
    if (!String(value || "").trim()) return "";
    try {
      const parsed = JSON.parse(value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return "Expected a JSON object.";
      return "";
    } catch (err) {
      return err.message;
    }
  }, [value]);
  return (
    <div class={`json-field ${error ? "invalid" : ""} ${className}`.trim()}>
      <Textarea
        rows={rows}
        monospace
        value={value}
        onInput={onInput}
        disabled={disabled}
        placeholder={placeholder || '{"KEY":"value"}'}
      />
      <div class="json-field-status" role={error ? "alert" : undefined}>
        {error ? `Invalid JSON: ${error}` : "JSON object"}
      </div>
    </div>
  );
}

export function PathOrUrlInput({
  value,
  onInput,
  placeholder,
  disabled,
  kind = "path",
  class: className = "",
}) {
  return (
    <div class={`path-url-input ${className}`.trim()}>
      <Icon name={kind === "url" ? "external" : "terminal"} size={14} class="path-url-input-icon" />
      <Input
        value={value}
        onInput={onInput}
        placeholder={placeholder}
        disabled={disabled}
        class="path-url-input-control"
      />
    </div>
  );
}

export function TagInput({
  value = [],
  onChange,
  placeholder = "Add tag",
  disabled = false,
  class: className = "",
}) {
  const [draft, setDraft] = useState("");
  const tags = Array.isArray(value) ? value : [];

  function addTag() {
    const next = draft.trim();
    if (!next || tags.includes(next)) {
      setDraft("");
      return;
    }
    onChange?.([...tags, next]);
    setDraft("");
  }

  function removeTag(tag) {
    onChange?.(tags.filter((item) => item !== tag));
  }

  return (
    <div class={`tag-input ${className}`.trim()}>
      <div class="tag-input-chips">
        {tags.map((tag) => (
          <span key={tag} class="chip tag-input-chip">
            {tag}
            <button type="button" disabled={disabled} aria-label={`Remove ${tag}`} onClick={() => removeTag(tag)}>
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
      </div>
      <div class="tag-input-row">
        <Input
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addTag();
            } else if (event.key === "Backspace" && !draft && tags.length) {
              removeTag(tags[tags.length - 1]);
            }
          }}
        />
        <Button size="sm" variant="secondary" disabled={disabled || !draft.trim()} onClick={addTag}>Add</Button>
      </div>
    </div>
  );
}
