# Worklab UI Design System

> **Status:** Schema v2. Prescriptive — every rule is meant to be executed, not debated.
> **Scope:** Stable design-system foundations for Worklab plus target-product blueprints derived from `src/ui/` and `ds-prototype/`. Current route/API truth and backend prerequisites are called out explicitly.
> **Audience:** Whoever builds, reviews, or extends the Worklab interface.

---

## 0. How to read this document

This is a schema, not a report. Each primitive, composite, pattern and screen is specified with enough detail that an engineer can implement it without guessing. When a rule requires a judgment call, the rule itself makes the call and states the *why* in one line — that's how we stay decisive. If something here contradicts a current CSS rule, the document wins.

This document uses three explicit markers. Any rule without a marker applies to the current shipped baseline.
- **[Current]** — matches the shipped product; source of truth in `src/ui`, `src/core`, and `src/api`.
- **[Target]** — preferred future behavior, prototype-driven; not assumed to exist yet. Never ship [Target] rules ahead of the backend that supports them.
- **[Requires backend]** — UI behavior that depends on a schema, API, scheduler, or coordinator change. Each has a matching entry in §9.3.

Foundations (sections 1–4) apply to both tracks unless called out. Patterns and screens call out track-specific behavior inline.

Three verbs have precise meaning:
- **must** — non-negotiable. Violating it is a bug.
- **should** — strong default. Override requires a comment in the code explaining why.
- **may** — opt-in capability. No default.

Every primitive specifies Purpose, Anatomy, Props, States, Do / Don't, Accessibility. Every screen specifies Purpose, Primary action, Layout, Inventory, Data contract, States, Keyboard. When a section omits one of these, assume the inherited rule from a higher-level section applies.

Numbers (px, ms) are in integers. Colors refer to tokens — never raw hex outside section 2.

---

## 1. Principles

Seven rules. They cascade: if two rules conflict, the earlier one wins.

### 1.1 Calm by default, loud when real-time
Idle surfaces are quiet — no gradients, no animation, no glow. The moment a surface represents *work in flight* (a running task, a streaming log, a subscribing event source), it earns motion: a pulsing dot, a shimmer bar, a tool-token ticking in. This is the only place motion lives. Static screens do not animate anything the user did not trigger.

**How it shows up:** `StatusDot` and `LivePulse` pulse only while a run is actively streaming (`run.status === "running"`), not merely because a task sits in `in_progress` or `in_review`. `ShimmerBar` only mounts while a run is streaming. Hover changes are 120ms and limited to color/opacity. Press feedback may darken or inset, but never translates the element.

### 1.2 Status is a first-class citizen
Every task, run, agent, provider, skill and KB entry has exactly one canonical state the user can read in under a second. State lives in color (semantic tokens) and a one-word label (pill). It never lives in icons alone, never in a sentence, never in a timestamp gap.

**How it shows up:** `StatusPill` is the sole carrier of status. Its color is driven by a status→token map; its label comes from a single `statusMeta()` function so "In review" is "In review" everywhere.

### 1.3 One primary action per screen
Each surface has one obvious button the user reaches for. Secondary actions are ghost-weight. Tertiary actions live under a twist-open or behind a keyboard shortcut. If two actions seem equally primary, one of them is not.

**How it shows up:** Commander's primary is "New task". TaskEdit's primary is "Save". TaskDetail's primary is "Run now" (or "Cancel run" while a run is live). Any screen with two primaries fails review.

### 1.4 Density is a contract
Commander is dense: 44px rows, 11px mono IDs, 13px titles. TaskDetail is spacious: 24px hero padding, 16px card padding, 14px body. These are not stylistic choices, they are contracts. Mixing densities within one screen is a bug.

**How it shows up:** The Commander row grid and spacing never appears outside Commander. The two-pane list is dense-medium (36px rows). Cards in TaskDetail right rail use spacious internal padding.

### 1.5 No decorative noise
If a visual element does not inform, it does not ship. No empty icons, no "nice texture" surfaces, no color for color's sake. Every chip, badge, dot, bar, and border answers a question the user is holding.

**How it shows up:** Chips carry meaning (priority, category, trigger). Divider lines only appear between grouped rows where the group boundary is load-bearing. Background surfaces use at most three elevation levels; no gradients on static surfaces.

### 1.6 Progressive disclosure
Primary fields live in the main form. Advanced knobs (journal tail lines, worker timeout, reasoning levels, custom system prompts) live behind a single twist-open. A 20-field form compresses to a 5-field form with an "Advanced" toggle. Always.

**How it shows up:** `AdvancedMeta` wraps anything that isn't required for a first-time user. Defaults are conservative. Settings are section-grouped with clear titles, not flat.

### 1.7 Every state has a name
Empty, loading, streaming, error, disabled, success, empty-after-filter — each is a distinct design, never an accidental one. "It looks fine when you have data" is not a design. Every list, detail, form, and card specifies what it looks like with zero data, with partial data, during load, when filtered to nothing, and when the backend errored.

**How it shows up:** `EmptyState`, `LoadingState`, `ErrorState` are the three canonical shapes. Every surface uses one of them — never inline "no items" text.

---

## 2. Foundations

### 2.1 Color

Worklab is dark-only. No light-mode branch exists or is planned. The palette is warm-white text on a cool-dark ground, accented by a cool blue for action and warm semantic colors for status.

#### 2.1.1 Surface tokens

| Token | Purpose | Value ref |
|---|---|---|
| `--bg` | Viewport background. The deepest layer. | `#08090a` |
| `--surface` | Default raised surface for cards, panels, rows. | `#0f1114` |
| `--surface-elevated` | Hover / active row, selected list row, primary button hover. | `#151820` |
| `--surface-sunken` | Code blocks, tool output, inset fields and controls. | `#0a0b0f` |
| `--border` | Default hairline border. 1px only. | `rgba(255,255,255,0.08)` |
| `--border-strong` | Separators between sections, card outlines on hover. | `rgba(255,255,255,0.14)` |
| `--border-focus` | Focus-visible ring and active form-field border. | `rgba(159,184,255,0.5)` |

**Usage rules:**
- `--bg` is the viewport only. No other element uses it.
- `--surface` is the default for any container that holds content. All cards, list rows (unselected), panels use `--surface`.
- `--surface-elevated` marks interactive state only: hover, selection. Never static decoration.
- `--surface-sunken` marks inset content: code/log output and embedded controls. If a control is editable, border/focus treatment must carry the interactivity. Never use it as decorative chrome.
- Borders use `--border` by default. `--border-strong` appears only between major sections or on floating surfaces (menus, toasts).

#### 2.1.2 Text tokens

| Token | Purpose | Contrast vs --surface |
|---|---|---|
| `--text` | Primary body text, input values, row titles. Warm white. | AA-large on `--surface` |
| `--text-muted` | Secondary meta: timestamps, counts, hint rows. | AA-large |
| `--text-subtle` | Tertiary chrome: placeholders, divider labels, disabled-like copy. | AA-normal small text |
| `--text-inverse` | Text on `--accent` buttons. | AAA on accent |

**Usage rules:**
- The cascade is `text → muted → subtle`. Never skip a level.
- Inline code, task IDs, and metric values may use `--text` on `--surface-sunken` to pop.
- Disabled state uses `--text-subtle` + 60% alpha on the containing element; never a new token.

#### 2.1.3 Accent tokens

| Token | Purpose |
|---|---|
| `--accent` | Primary action color: primary button, focus ring core, active nav. |
| `--accent-hover` | Primary button hover. |
| `--accent-active` | Primary button pressed. |
| `--accent-soft` | Accent background tint, at 10% of accent over `--surface`. |

Only one accent. "Primary action" is defined by principle 1.3. No secondary accents.

#### 2.1.4 Semantic status tokens

Every state has exactly one color. Pills and dots use the same palette — the difference is in shape, not hue.

| Token | Role | Meaning |
|---|---|---|
| `--status-todo` | "Todo" / "Planned" | Teal. Cold, waiting. |
| `--status-progress` | "In progress" / "Running" | Yellow-amber. Alive, attention. |
| `--status-review` | "In review" | Lavender. Waiting for a verdict. |
| `--status-done` | "Done" / "Complete" | Green. Settled. |
| `--status-error` | "Error" / "Failed" / "Blocked" (target-only task state) | Red-pink. Broken. Requires a human. |
| `--status-muted` | "Disabled" / "Cancelled" / "Archived" | Grey. Off. |

Each status token ships in three tints for backgrounds:
- `--status-*-bg-10` — pill background at 10% alpha.
- `--status-*-bg-20` — pill hover / active row background.
- `--status-*-border` — pill border at 35% alpha.

Status tints are the default non-neutral backgrounds for state. `--accent-soft` is the only other sanctioned tint and only for selection, active navigation, and active filter state.

#### 2.1.5 Agent avatar hues

Agent avatars get a deterministic hue from `hash(name) % 360` in HSL with `S=45%, L=55%` on the colored chip and `S=25%, L=20%` on the matching background. Initial letters use `--text` at `L=95%`. The function lives in `AgentAvatar.jsx` and must not be duplicated.

**Rule:** Avatar hue derives from stable agent identity only: `agent.name` today, or a persisted `color` field if one is ever added. Never derive from `display_name` or role. Executor and reviewer of the same agent share the same hue; role is conveyed by label or placement, not by color.

#### 2.1.6 Contrast reference

All text-on-surface pairs must meet WCAG AA for the relevant size:
- `--text` on `--surface`: AA-normal at 13px and above; AAA at 14px.
- `--text-muted` on `--surface`: AA-large at 14px and above; must upgrade to `--text` at 11px or below.
- `--text` on `--accent`: AAA.
- Status pill label on its own `--status-*-bg-10`: AA-normal at 12px+ (tokens are tuned for this).

When in doubt, increase font size or drop to `--text`.

### 2.2 Typography

One sans stack and one mono stack. No display or serif faces.

```
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
```

#### 2.2.1 Scale

Eight sizes. Every text style maps to one. No other size appears in a stylesheet.

| Token | Size | Role | Weight | Line-height |
|---|---|---|---|---|
| `--text-xs` | 11px | All-caps kickers, badge labels, keyboard hints. | 500 | 1.2 |
| `--text-sm` | 12px | Meta rows, timestamps, small chips. | 500 | 1.3 |
| `--text-base` | 13px | Default body, form labels, dense row content. | 400–500 | 1.4 |
| `--text-md` | 14px | Default prose, comment bodies, long descriptions. | 400 | 1.5 |
| `--text-lg` | 16px | Section headings (h3), card titles. | 600 | 1.3 |
| `--text-xl` | 20px | Screen titles (h2), hero titles in detail panes. | 600 | 1.25 |
| `--text-2xl` | 24px | Empty-state titles, toast titles. | 600 | 1.2 |
| `--text-3xl` | 32px | Only on dashboard/hero surfaces when needed. Currently unused. | 600 | 1.15 |

**Mono variants** inherit from the sans scale but shift two steps down in perceived size because mono is denser:
- Task IDs and small metric values: `--text-xs` (11px).
- Log event content, tool output, code: `--text-sm` (12px).
- All monospaced headers and row labels use `--text-base` (13px) max — never 13.5, never 12.5.

**Banned sizes:** 10.5, 11.5, 12.5 do not exist. The current codebase uses all three; they are removed. Every occurrence migrates to the nearest token value.

#### 2.2.2 Weight

- 400 for prose.
- 500 for form labels, metadata values, button labels.
- 600 for headings and emphasized actions.
- 700 is reserved for "Save" / "Run" primary buttons and for h1 if ever used.

#### 2.2.3 Letter-spacing and casing

- All-caps kickers (section labels, tool-call section headers) use `letter-spacing: 0.08em` at 11px. Never all-caps at 12px or larger.
- Display titles (`--text-xl` and above) use `letter-spacing: -0.01em`.
- Everything else is 0.

### 2.3 Spacing

Base 4. Scale is strict — no `7px`, no `margin: 5px`.

| Token | Value |
|---|---|
| `--sp-0` | 0 |
| `--sp-1` | 4px |
| `--sp-2` | 8px |
| `--sp-3` | 12px |
| `--sp-4` | 16px |
| `--sp-5` | 20px |
| `--sp-6` | 24px |
| `--sp-8` | 32px |
| `--sp-12` | 48px |
| `--sp-16` | 64px |

**Rhythm rules (non-negotiable):**

- Label → control gap: `--sp-2` (8px).
- Control → hint gap: `--sp-1` (4px).
- Hint → error gap: `--sp-1` (4px).
- Field → next field (same section): `--sp-5` (20px).
- Section → next section (same screen): `--sp-8` (32px).
- Card padding (default): `--sp-4` (16px).
- Card padding (spacious, in TaskDetail hero/rail): `--sp-6` (24px).
- Commander row vertical padding: `--sp-2` (8px). Row total height: 44px idle, 56px live.
- Two-pane list row vertical padding: `--sp-2` (8px). Row total: 36px.

### 2.4 Radii

| Token | Value | Used on |
|---|---|---|
| `--radius-xs` | 2px | Tag chips, hairline chips. |
| `--radius-sm` | 6px | Form fields, buttons, cards, small menus. |
| `--radius-md` | 10px | Modals, toasts, drawers, primary cards. |
| `--radius-pill` | 999px | Status pills, avatars, filter pills. |

No other radii appear in CSS. `border-radius: 4px` or `8px` in the current codebase migrates to the nearest token.

### 2.5 Elevation

Three levels. No box-shadows beyond these.

| Level | Definition | Used on |
|---|---|---|
| `--elev-flat` | `none` (borders only). | All static content: cards, rows, fields. |
| `--elev-raised` | `0 0 0 1px var(--border-strong), 0 2px 6px rgba(0,0,0,0.25)` | Floating menus (SelectField menu, AgentPicker menu, tooltip). |
| `--elev-float` | `0 12px 32px -8px rgba(0,0,0,0.55), 0 0 0 1px var(--border-strong)` | Modals, toasts, drawers. |

No inner shadows. No glow effects outside the pulse animation.

### 2.6 Motion

Motion is a safety-critical part of the design, not decoration. Its job is to mark work in flight and to keep layout changes from teleporting.

#### 2.6.1 Durations

| Token | Value | Use |
|---|---|---|
| `--dur-snap` | 120ms | Hover color changes, button press, focus ring. |
| `--dur-std` | 200ms | Menu open/close, drawer slide, toast enter. |
| `--dur-ovlay` | 320ms | Modal fade, backdrop reveal. |
| `--dur-shimmer` | 1600ms | Shimmer-bar cycle (never user-triggered). |
| `--dur-pulse` | 1600ms | Status-dot pulse. |
| `--dur-tick` | 300ms | `wl-tick-in` event entry. |

#### 2.6.2 Easings

| Token | Curve | Use |
|---|---|---|
| `--ease-snap` | `cubic-bezier(.2,.7,.3,1)` | Default for short UI transitions. |
| `--ease-std` | `cubic-bezier(.25,.1,.25,1)` (ease) | Menus, drawers. |
| `--ease-emphasized` | `cubic-bezier(.2,.8,.2,1)` | Modal entry, empty-state float-in. |

#### 2.6.3 Keyframes

Six named keyframes. No other `@keyframes` may be defined. Hover, focus, and press transitions use CSS `transition` — not keyframes — and draw durations from §2.6.1 (`--dur-snap` is the default for hover/press, `--dur-std` for menu/drawer entry).

| Name | Duration | Role |
|---|---|---|
| `wl-pulse` | 1600ms, infinite, `--ease-std` | Status-dot outer ring pulsing when running. |
| `wl-tick-in` | 300ms, once, linear | Event entering the timeline or the Commander live line. |
| `wl-shimmer` | 1600ms, infinite, linear | Gradient sweep across a 2px bar while streaming. |
| `wl-caret` | 1000ms, infinite, steps(2) | Blinking caret at the end of a streaming text block. |
| `wl-float-in` | 180ms, once, `--ease-snap` | Toast entering the region. Empty-state illustration. |
| `wl-confirm-pulse` | 1200ms, 1 cycle, `--ease-std` | ConfirmButton armed state. |

**Reduced-motion:** Under `@media (prefers-reduced-motion: reduce)`:
- `wl-pulse` collapses to a static 0.6-alpha ring.
- `wl-shimmer` becomes a static 1px accent line.
- `wl-tick-in` and `wl-float-in` are skipped (opacity 1 instantly).
- `wl-caret` and `wl-confirm-pulse` stop.

---

## 3. Primitives

Every primitive has exactly one file under `src/ui/src/components/primitives/`. Every primitive exports a single default component plus any related helper (e.g., `statusMeta()`). Primitives must not import from `routes/`.

### 3.1 Button

**Purpose** — The sole affordance for a direct user-initiated action.

**Anatomy** — Leading icon (optional) · label · trailing icon (optional).

**Props** — `variant: "primary" | "secondary" | "ghost" | "destructive"`, `size: "sm" | "md" | "lg" = "md"`, `disabled`, `loading`, `iconLeft`, `iconRight`, `aria-label` (required if icon-only), `type`, `onClick`.

**Variants**
- **primary** — filled with `--accent`, `--text-inverse` label, weight 700. One per screen (principle 1.3).
- **secondary** — `--surface-elevated` fill, `--border-strong`, `--text` label, weight 500. Default non-primary action.
- **ghost** — transparent fill, `--border` on hover only, `--text-muted` label becoming `--text` on hover. Chrome actions (filter pills, nav).
- **destructive** — `--status-error-bg-10` fill, `--status-error-border`, `--status-error` label. Paired with `ConfirmButton` for dangerous ops.

**Sizes** — `sm: 28px`, `md: 32px`, `lg: 40px` height. Horizontal padding `--sp-3 / --sp-4 / --sp-5`.

**States**
- default, hover (lift `--accent-hover` or `--surface-elevated`), active (pressed state darkens/insets; no translate), focus-visible (2px `--accent` outline, 2px offset), disabled (60% opacity, not-allowed cursor), loading (spinner replaces label, width is preserved).

**Do / Don't**
- Do pair a destructive action with a confirmation step unless the op is cheap to undo.
- Don't nest buttons. Don't use primary variant for "cancel".
- Don't put two primary buttons side by side.

**A11y** — Must have visible text or `aria-label`. Focus ring is `--accent` 2px outside, 2px offset. Disabled sets `aria-disabled="true"`, does not disable focus.

### 3.2 IconButton

**Purpose** — Compact, icon-only action when space is dense (row context menus, toolbar in a narrow rail).

**Anatomy** — 28x28 or 32x32 square, icon centered.

**Props** — `icon`, `aria-label` (required), `variant: "ghost" | "secondary" = "ghost"`, `size`.

**States** — Same as Button. Focus ring is `inset 0 0 0 2px --accent` plus the outer ring.

**Do / Don't** — Use when label would be "Copy", "More", "Close", and the context makes that obvious. Don't use for primary actions.

**A11y** — `aria-label` must describe the action ("Copy task ID"), never the icon ("copy icon").

### 3.3 Input

**Purpose** — Single-line text / number / password entry.

**Anatomy** — `--surface-sunken` background, 1px `--border`, `--sp-3` horizontal padding, 32px height (md), 28px height (sm).

**Props** — `type`, `value`, `onInput`, `placeholder`, `disabled`, `readOnly`, `invalid`, `aria-describedby`.

**States**
- default, hover (border → `--border-strong`), focus (border → `--border-focus`, outline dropped because border is the ring), disabled (50% opacity, background flattened), invalid (border `--status-error`, trailing icon).

**Do / Don't**
- Do use `type="number"` for numeric fields, with `min`/`max`.
- Don't rely on placeholder as label.
- Don't use `outline: 0` without replacing the focus affordance with a visible border change.

**A11y** — Associated `<label>` or `aria-labelledby` is required. Error message is linked via `aria-describedby`.

### 3.4 Textarea

**Purpose** — Multi-line text entry.

**Anatomy** — Identical to Input. Resize: `vertical`. Minimum 3 lines; description fields default to 5 lines.

**Props** — `value`, `onInput`, `rows`, `monospace: bool`, `autoGrow: bool`, `placeholder`, `disabled`.

**Behaviour** — When `autoGrow` is true, height grows with content up to `maxHeight: 40vh`, then scrolls. When `monospace` is true, use `--font-mono` and `--text-sm`.

**Do / Don't** — Instructions fields for agents and tasks are monospace. Descriptions are sans.

### 3.5 SearchField

**Purpose** — Filter within a list scope.

**Anatomy** — Search icon (leading) · input · keyboard shortcut hint (trailing, optional) · clear button (trailing, when value is non-empty).

**Props** — `value`, `onInput`, `placeholder`, `shortcut` (e.g., `"/"`), `onClear`.

**States** — default, focus (border `--border-focus`, `wl-float-in` on clear button appearing), empty, filled.

**A11y** — `role="search"` on the wrapper, `aria-label` on input. `/` keystroke focuses via global handler; `Esc` clears and blurs.

### 3.6 Select (unified)

**This primitive replaces the current split between `SelectField` and `AgentPicker`.** The two were visually inconsistent (32px vs ~33px heights, different paddings, different menu widths, different option layouts). The unified primitive has one trigger shape and one menu shape; variants live inside.

**Purpose** — Pick one value from an enumerated list. Two variants: **`native`** (short lists, no search, uses the OS control) and **`menu`** (rich options with optional avatar/description, searchable).

**When to use which**
- `native` — lists of 2–7 simple strings (priority level, on/off, reasoning effort preset).
- `menu` — lists of 8+ items OR lists with rich rows (agent avatar + role, model with description, KB category badge + title). Always when search is useful.

**Anatomy (menu variant)**
- Trigger: 32px height, `--sp-3` horizontal padding, left slot (optional icon/avatar), label slot (current value), trailing chevron. Border `--border`, background `--surface-sunken`, radius `--radius-sm`.
- Menu: `--elev-raised`, radius `--radius-sm`, max-height 320px, `overflow: auto`. Width equals trigger width by default; explicit `menuWidth` prop overrides.
- Option: 36px height, `--sp-2` padding, `gap: --sp-3`, optional leading slot (avatar, category badge, color swatch), primary label, optional `--text-muted` description.
- Group header: `--text-xs`, all-caps, `--text-muted`, `--sp-2` top padding.
- Search input: only shown when `searchable: true` OR options count > 8. 32px, sticky at top of menu.

**Props**
- `value`, `onChange(value)`, `options: Array<Option> | Array<Group>`
- `variant: "native" | "menu" = "menu"`
- `searchable: bool = auto`
- `renderOption(opt)` — optional custom row renderer.
- `leadingSlot(opt)` — optional renderer for the trigger's leading element.
- `placeholder`, `disabled`, `ariaLabel`.

**Option shape**
```ts
{ value: string, label: string, description?: string, icon?: ReactNode, disabled?: bool }
```

**States**
- Trigger: default / hover (border `--border-strong`) / open (border `--border-focus`, chevron rotated) / disabled.
- Option: default / active (keyboard-highlighted, `--surface-elevated`) / selected (`--accent-soft` tint, check icon trailing) / disabled (50% opacity).

**Do / Don't**
- Do use `menu` variant for agents, models, KB categories. The trigger *must* show the same richness as the option (avatar + name + role).
- Don't mix `menu` and `native` variants in the same form. Pick one row rhythm and hold it.
- Don't show option descriptions in the trigger unless there's space — the trigger shows label only by default.

**A11y** — `role="combobox"` on trigger, `role="listbox"` on menu, `role="option"` on rows, `aria-activedescendant` to track keyboard highlight. Arrow keys navigate, Enter selects, Escape closes.

### 3.7 Switch

**Purpose** — Binary on/off for settings that take effect immediately or on save.

**Anatomy** — 30x18 track · 14x14 thumb · label · optional description.

**Layout** — The whole primitive is a single grid row: `grid-template-columns: auto 1fr` with the track on the left, copy on the right. The track is `grid-row: 1 / span 2` with `align-self: start` (it aligns to the *top* of the copy, not the center). Copy column is `flex-direction: column` with `gap: --sp-1`, label 13/500, description 12/muted.

**This layout fixes the current misalignment bug.** The current CSS places the track at `grid-row: 1 / span 2` with `margin-top: 2px`, which centers the track against a two-line copy block. Replace with `align-self: start` (no margin) so the track always aligns to the label's x-height.

**Props** — `checked`, `onChange`, `label` (string) or children (node), `description?`, `disabled`.

**States** — default off / on / hover (track brighter) / focus-visible (2px `--accent` outline on the track, outside) / disabled (50% opacity).

**Do / Don't** — Do pair with a description when the label alone isn't enough. Don't use switches for "choose one of two" (use Radio group); use them only when off vs on has a meaningful default.

**A11y** — `role="switch"`, `aria-checked`. Entire area is clickable; space toggles.

### 3.8 Checkbox

**Purpose** — Multi-select or compound on/off.

**Anatomy** — 16x16 box, check icon when on, label, optional description.

**States** — unchecked / checked / indeterminate / disabled / focus-visible (ring).

**Do / Don't** — Use for bulk selection in Commander (row checkboxes); use for feature matrices (agent skills/tools). Don't use for primary settings where a Switch reads better.

### 3.9 Radio group

**Purpose** — Pick exactly one of 2–4 mutually exclusive options where seeing all options at once is valuable.

**Anatomy** — Segmented bar: pill container with inner divisions, each option a press target with label.

**When to prefer over Select** — When the choices are all short words and the user benefits from seeing them side by side. "Reasoning effort: low / medium / high" is a classic fit.

**Props** — `value`, `onChange`, `options: {value, label, icon?}[]`, `ariaLabel`.

**A11y** — `role="radiogroup"` with arrow-key navigation.

### 3.10 Chip

**Purpose** — Inline metadata badge.

**Variants**
- **tag** — `--surface-elevated` fill, `--border`, `--text-muted`. User-applied tags.
- **category** — tinted per KB category (ref / how-to / policy). Shape: pill. Uppercase 11px label.
- **trigger** — accent-tinted. Skill trigger modes.
- **filter** — toggleable pill in a filter bar. Selected = `--accent-soft` fill + `--accent` border.

**Not a chip:** StatusPill, ToolToken. These are their own primitives.

**Anatomy** — 20–22px height, `--sp-2` horizontal padding, 12px label, optional 12px leading icon.

**Props** — `variant`, `children`, `onRemove` (only when removable).

### 3.11 StatusPill

**Purpose** — The sole visual carrier of state (principle 1.2).

**Anatomy** — Pill shape: 22px height, `--sp-3` padding, `--radius-pill`. Leading dot or icon (12px) · label (11px/500, no tracking).

**Props** — `status: "todo" | "in_progress" | "in_review" | "done" | "running" | "complete" | "failed" | "cancelled" | "disabled" | "error"`, `label?` (override default from `statusMeta()`), `size: "sm" | "md" = "md"`.

**Status coverage** — The primitive paints both task-level states (`todo / in_progress / in_review / done`) and run-level states (`running / complete / failed / cancelled`), plus `disabled` for agents/providers and `error` where an entity exposes a generic failure affordance. Per §5.4 the host surface decides which state source it is painting — the primitive is shared, the data is not conflated.

**Width** — The pill fits its container and truncates its label at the container's width; a Tooltip (§3.19) surfaces the full label on hover/focus. The host cell — Commander row, card header, list row — is responsible for reserving a width that fits the expected labels. The Commander row (§4.4) reserves 104px, which fits every current label. **This fixes the current Commander overlap bug: width is driven by the cell, not the pill.**

**Do / Don't**
- Do use exactly one pill per row/panel. Don't stack pills.
- Don't invent new statuses. If the backend introduces one, add it to `statusMeta()` first, then reference it.

**A11y** — The pill is *decorative if the label is already read by a surrounding heading*, otherwise it's `aria-label`ed.

### 3.12 StatusDot

**Purpose** — Compact status indicator where a pill is too heavy (Commander row leading column, inline beside avatars, dependency links).

**Anatomy** — 8px inner circle. Optional 14px outer ring that pulses on `wl-pulse` when `pulse: true`.

**Props** — `status`, `pulse: bool = false`, `size: number = 8`.

**Rule:** `pulse` is true only while a run for the associated entity is actively streaming events (`run.status === "running"`), not merely because the task sits in `in_progress` or `in_review`. This keeps the "loud when real-time" semantic of §1.1 truthful: an in-review task whose reviewer has not yet started is quiet.

### 3.13 PriorityChip — REMOVED

Priority is no longer a task concept. The chip, the field on TaskEdit, the
KV row on TaskDetail, the column in `tasks`/`schedules`, and the related
filter behaviour are all gone (schema v5 migration in `src/core/db.js`).
Tasks have no inherent priority — agents decide. Do not reintroduce.

### 3.14 LivePulse

**Purpose** — Small "alive" marker, visually richer than `StatusDot` with `pulse`.

**Anatomy** — 10px core dot + 16px ring, animated with `wl-pulse`.

**Props** — `color` (defaults to `--status-progress`), `size`.

**Use** — TaskDetail hero when a run is streaming, AppShell header when there is any running task across the app.

### 3.15 ShimmerBar

**Purpose** — A subtler "streaming" cue than LivePulse — a 2px horizontal line with an accent gradient sweeping along it.

**Anatomy** — 2px height, full width of its container. Gradient: `linear-gradient(90deg, transparent, --accent, transparent)` with `wl-shimmer`.

**Use** — Directly below a hero title in TaskDetail during a live run. Top edge of the LiveRunPanel. Never static.

### 3.16 ToolToken

**Purpose** — Compact, inline representation of a single tool call or agent thought.

**Anatomy** — Pill shape · leading icon (tool-specific or generic) · monospaced label "tool: arg" truncated at 320px max-width (256px on mobile) · trailing status glyph (running / done / error).

**Props** — `event: { kind, name, arg?, detail?, text? }`, `compact: bool`.

**Kinds**
- `tool` — shows `name(arg)`; icon picked from a lookup (read/write/grep/run/http/other).
- `think` — italic, purple (`--status-review`), no icon except the prefix glyph.
- `handoff` — accent background, `"handed off to <agent>"`.
- `text` — short text preview, no icon, italic.

**Do / Don't** — Don't let the arg exceed one line; truncate with ellipsis and show full on hover (Tooltip). Don't show empty tokens.

### 3.17 AgentAvatar

**Purpose** — Recognizable, compact identifier for an agent.

**Anatomy** — Circle with deterministic hue background and initials in warm white. Sizes 16 / 20 / 24 / 28px.

**Props** — `name` (drives hue and initials), `label`, `size`, `title`, `compact`, `role?: "executor" | "reviewer"`.

**Rule:** The role sub-chip (`E` for executor, `R` for reviewer) appears only in task-context views where both roles are visible at once — Commander row (when space allows), TaskDetail hero, TaskDetail rail's Agents card. In agent-listing contexts (Agents pane, AgentEdit) no sub-chip appears; the row copy carries role if needed. Role is never conveyed by hue change.

**Unassigned** — Dashed border, no fill, "?" initial at `--text-subtle`.

### 3.18 Badge

**Purpose** — Numeric count attached to a nav item or section header (e.g., "Agents · 7").

**Anatomy** — 18px pill, mono 11px label. `--surface-elevated` background, `--text-muted` label.

### 3.19 Tooltip

**Purpose** — Reveal truncated text or secondary info on hover/focus without adding chrome.

**Anatomy** — Floating card, `--elev-raised`, `--text-sm`, `--sp-2` padding, max-width 260px, arrow pointer optional.

**Timing** — 400ms hover delay, 120ms fade-in. Dismisses on mouseout or Escape.

**Use** — Any truncated title, any icon-only button's `aria-label`, any status pill whose label overflowed, any agent avatar without an adjacent name.

**A11y** — `role="tooltip"`, linked via `aria-describedby`. Focusable trigger shows it on focus, not just hover.

### 3.20 Kbd

**Purpose** — Render a keyboard shortcut inline.

**Anatomy** — Mono 11px, `--surface-elevated` fill, 1px `--border`, `--radius-xs`, 4px padding, inline-flex.

**Use** — Filter bar ( `[/]` for search ), edit form header ( `[⌘ S]` for save ), empty-state hints.

### 3.21 Divider

**Purpose** — Section separation within a card or panel.

**Anatomy** — 1px `--border` horizontal rule, full width, `--sp-4` vertical margin.

**Rule:** Dividers only appear between distinct semantic groups. If two blocks share meaning, use spacing (`--sp-5`), not a line.

### 3.22 Link

**Purpose** — Navigate the user to another surface.

**Anatomy** — `--accent` color, 1px underline on hover only. Visited state does not change color.

**Internal links** are hash-routed and use the global hash-router. External links open in a new tab with `rel="noopener noreferrer"` and a 10px trailing "external" glyph.

### 3.23 Breadcrumb

**New primitive.** Currently inline-styled in `TaskDetail.jsx` lines 236–239; extract.

**Purpose** — Show the path from a top-level nav to the current surface.

**Anatomy** — `<Link>` · `›` · `<Link>` · `›` · current label (non-clickable, `--text-muted`).

**Rule:** Breadcrumb has at most 3 levels. Truncate middle levels with ellipsis if the path is deeper (e.g., "Tasks › … › Task #abcd").

### 3.24 Tab / TabGroup

**Purpose** — Switch between sibling views in the same scope (e.g., Knowledge category filter, Providers by type, Agents by role).

**Anatomy** — Horizontal row of tabs, each 32px height. Active tab has 2px bottom border in `--accent`, `--text` label. Inactive tabs use `--text-muted`. `--sp-4` gap between tabs.

**Props** — `value`, `onChange`, `tabs: {value, label, count?}[]`.

**A11y** — `role="tablist"`, `role="tab"`, arrow-key navigation, `aria-selected`.

---

## 4. Composite components

Composites live under `src/ui/src/components/` (not `primitives/`). Each composite is built from primitives — composites may not define new tokens.

### 4.1 FormField

**New composite.** Currently the codebase uses a `.field` div wrapped around ad-hoc label + control + hint. This gets promoted to a reusable component so every form on every screen has the same label/control/hint rhythm.

**Purpose** — A single form row: label, control slot, hint, error.

**Anatomy** (top to bottom)
1. Label row: text (13/500) + optional required marker (`*` in `--status-error`) + optional hint-icon (hover tooltip for long context).
2. Control slot (any primitive: Input, Textarea, Select, Switch, AgentPicker-as-Select-menu).
3. Hint row (12/muted), only if `hint` is set.
4. Error row (12, `--status-error`), only if `error` is set.

**Props** — `label`, `required`, `hint`, `error`, `helpTooltip`, `children`.

**Layout** — Vertical flex, `gap: --sp-2` between label and control, `--sp-1` between control and hint/error.

**Rule:** When a Switch is inside a FormField, the FormField's internal vertical stack does NOT apply — Switch owns its own row-layout (label on the right of the track). The FormField simply passes through.

### 4.2 FormSection

**Purpose** — Group related FormFields under a titled heading.

**Anatomy** — Kicker (11/caps/muted) + heading (16/600) + optional description (13/muted) + `FormGrid` of fields.

**Margin** — `--sp-8` below. This enforces principle 1.4's section rhythm.

### 4.3 FormGrid

**Purpose** — Responsive N-column grid for FormFields.

**Props** — `columns: 1 | 2 | 3 = 2`, `children`.

**Layout** — `display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: --sp-5 --sp-5`. Below 860px, collapses to 1 column.

**Rule:** Never span a FormField across multiple columns in a way that leaves a gap. If a field is naturally wide (textarea, long list), use `columns: 1`.

### 4.4 Commander row

**The canonical dense row.** Specified here so the column contract is unambiguous and stays resilient at laptop widths — **this is the fix for the current status-pill overflow without turning the row into a dashboard**.

**Purpose** — Represent one task in the Commander list.

**Anatomy (left to right)**
1. `checkbox` — 16px (multi-select).
2. `id` — 64px, mono 11px, `--text-muted`.
3. `dot` — 12px StatusDot with pulse when live.
4. `title cluster` — flexible, `min-width: 0`. Row 1 is title (13/500, truncate) plus at most one compact meta chip — `Stuck — reset` (worker died), `Error` (last run errored), or `Needs executor` (no executor assigned). Priority is removed from the model, so no priority chip exists. The `Blocked by N` chip lives in its own grid cell to the right of the title (cell 5), not inline. Row 2 is `live-line` only when live: ToolToken + short timestamp, 12/mono/muted, `wl-tick-in` on change.
5. `agents` — 80px, two overlapping 20px AgentAvatars (executor, reviewer).
6. `pill` — 104px, StatusPill (`max-width: 104px`).
7. `age` — 56px, mono 11px, `--text-muted`, right-aligned.

**Grid**
```
grid-template-columns: 16px 64px 12px minmax(0, 1fr) 80px 104px 56px;
column-gap: --sp-3;
```
**Height:** 44px idle, 56px while live (to accommodate live-line). Single-row transition uses `transition: min-height var(--dur-std) var(--ease-snap)`.

**States**
- default, hover (background → `--surface-elevated`), selected (multi-select) — accent left border 2px, live (dot pulses, live-line animates).

**Rule:** The load-bearing columns are title, agents, status, age. Priority/dependency context is supplementary and collapses before those columns do. `StatusPill` has `max-width: 104px` and the grid reserves that width, so it cannot bleed into `age`.

### 4.5 Pane layout

**Purpose** — Shared shell for Agents / Skills / Knowledge / Providers: a searchable list on the left, an inline detail editor on the right, all URL-synced.

**Anatomy**
- Left pane: 280px fixed width (320 on ≥1440), `--sp-4` padding. Header: SearchField + optional filter Tabs. Body: scrollable list of PaneRows.
- Right pane: `flex: 1`, `--sp-6` padding. Header: title + toolbar (save, delete). Body: form sections.

**Below 860px** — Collapses to a single pane: list view, then detail view on tap, with a back button.

**URL contract**
- `/#/<entity>` — list only, no selection.
- `/#/<entity>/<slug>` — list with `<slug>` selected and detail mounted.
- Clicking a row pushes `/#/<entity>/<slug>` (does not reload).
- Deep link to `/#/<entity>/<slug>` highlights and mounts the editor.
- "Back" from mobile detail goes to `/#/<entity>`.

### 4.6 PaneRow

**Purpose** — One row in a Pane list.

**Anatomy** — 36px height, `--sp-3` horizontal padding, `gap: --sp-3`. Leading slot (avatar, category badge, status dot) + title (13/500, truncate) + trailing slot (chip, count, age, status dot).

**Per-entity specifics**
- Agents: avatar · name + role chip · status dot (pulse if recent activity) · trailing "N runs · Xs avg".
- Skills: color dot · name · trigger chip · priority mini-badge · trailing "used by N".
- Knowledge: category badge · title · pinned marker (if pinned) · trailing age.
- Providers: type icon · name · status dot · trailing "M models".

**States** — default, hover (`--surface-elevated`), selected (`--accent-soft` left border 2px, background `--surface-elevated`), disabled (50% opacity).

### 4.7 Card

**Purpose** — A grouped rectangular surface with optional title and body.

**Anatomy** — `--surface` background, 1px `--border`, `--radius-sm`, `--sp-4` padding. Optional heading: 11/caps/muted kicker + 14/600 title.

**Variants** — `card` (default), `card-spacious` (`--sp-6` padding, for TaskDetail rail and hero), `card-inset` (no border, `--surface-sunken` background, for read-only output).

### 4.8 Metric

**New composite.** Currently repeated inline in TaskDetail rail. Promoted.

**Purpose** — Show a single numeric measurement with a label.

**Anatomy** — Label (11/caps/muted) above value (16/500/mono). Optional unit suffix (12/muted). Optional trailing trend glyph.

**Rule:** Metric values are monospace so they align vertically in a grid. Labels are all-caps kickers.

**Used in** — TaskDetail right rail (Tokens, Cost, Duration, Turns). Activity tiles.

### 4.9 Toast

**Purpose** — Ephemeral notification for the result of a user action.

**Anatomy** — `--elev-float`, `--radius-md`, `--sp-4` padding, 320px max-width. Color-coded left border by variant.

**Position** — Bottom-right, 24px from edge. Stack upward with `--sp-2` gap. Max 3 visible at once; oldest animates out first.

**Variants** — `success` (green border), `error` (red border), `info` (accent border).

**TTL** — 2500ms default. Errors 4500ms. Hover pauses.

**Animation** — `wl-float-in` on enter, fade on exit.

**A11y** — `role="status"` for info/success, `role="alert"` for errors.

### 4.10 Modal

**Purpose** — A blocking action that needs the user's full attention (destructive confirmations, first-run onboarding, detailed pickers).

**Anatomy** — `--elev-float`, `--radius-md`, 480px default width (sm 320, md 480, lg 720). Backdrop is a 60% black scrim with `wl-float-in` 180ms.

**Structure** — Header (title + close IconButton) · body · footer (ghost cancel + primary confirm, right-aligned).

**A11y** — `role="dialog"`, `aria-modal="true"`, focus trap on mount, Escape closes.

**When to use** — Destructive confirmation (Delete task, Reset to todo while running, Force unlock), non-trivial pickers that need their own keyboard flow. Otherwise inline-confirm or drawer.

### 4.11 Drawer

**Purpose** — A side panel that opens without leaving the current screen (filters, keyboard shortcuts help, agent runbooks).

**Anatomy** — Right-side, 400px wide, full-height, `--elev-float`. Slides in over 200ms with `--ease-std`.

**Rule:** Drawers are for read-mostly auxiliary content. Never for primary action flows.

### 4.12 EmptyState

**Purpose** — The canonical shape when a list has no items or a surface has no data.

**Anatomy** — Vertically centered. 64px icon (`--text-subtle`), 16/600 title, 13/muted body up to 320px wide, one primary Button.

**Two flavours**
- `EmptyState` — "No tasks yet. Create your first one." Button is the primary CTA.
- `EmptyStateFiltered` — "No tasks match your filter." Button resets filter.

### 4.13 LoadingState

**Purpose** — While we're waiting on an initial fetch.

**Anatomy** — Vertically centered. ShimmerBar (2px line, 120px wide) + small caption below: "Loading tasks…" at 13/muted.

**Rule:** Never render the skeleton of the real layout; render `LoadingState`. Rationale: skeleton shimmer requires careful sizing to not cause CLS; we'd rather show a small spinner and layout once.

### 4.14 ErrorState

**Purpose** — When a fetch failed or the surface cannot be rendered.

**Anatomy** — Same shape as EmptyState, with a red-tinted icon, title "Something broke", body shows the human-readable error, primary Button "Retry".

**Policy** — Use for screen-level failures. For inline field errors, use FormField's error slot. For background failures that the user can ignore, Toast.

### 4.15 EventRow

**The atom for the event timeline.** This is the fix for the log-typography inconsistency — every event, tool call, thinking block, phase, and final summary renders as an `EventRow` with consistent rhythm.

**Purpose** — One row in a run's event timeline.

**Anatomy**
- Rail: 12px column containing a dot (phase / tool / text / thinking / error have distinct glyphs), and a 1px vertical line connecting to the next row.
- Gutter: `--sp-3`.
- Content: flexible column. Top line is the event header — type label, mono timestamp (relative, e.g. `+12s`), and optional duration. Below is the body.

**Body typography — unified**
- Text content (assistant messages, thinking): sans, `--text-base`, `--text`, `line-height: 1.5`.
- Tool output / code: mono, `--text-sm`, `--text`, `line-height: 1.4`, `--surface-sunken` background, `--sp-3` padding, `--radius-sm`.
- Meta (final/summary inline): mono, `--text-xs`, `--text-muted`.
- Phase name + duration: sans, `--text-sm`, `--text-muted`.

**All monospaced text in the timeline uses `--text-sm` (12px).** No 11.5, no 12.5. **This fixes the log-inconsistency bug.**

**States**
- default, hover (subtle `--surface-elevated`), expanded (tool call / phase cluster reveals body), streaming (last row shows blinking caret `wl-caret` at end of text; row animates in via `wl-tick-in`).

### 4.16 ToolCallBlock

**Purpose** — Expandable view of a tool invocation with input and output.

**Anatomy**
- Summary row (closed): tool glyph + name + arg-preview (mono, truncated) + status glyph (running/done/error) + chevron.
- Expanded body: two `EventRow`-shaped subsections — `INPUT` (11/caps/muted label + pre block) and `OUTPUT` (same shape).

**Rule:** Headers are all-caps kickers at 11px, labels at 12/500. Content is mono 12. Same typography as EventRow body code. No divergent sizes.

### 4.17 Markdown

**Purpose** — Render task/comment/event text as formatted HTML.

**Rendering policy**
- Parse and render GFM-lite: headings h1–h3, paragraphs, bulleted/numbered lists, inline code, code blocks, links, bold, italic, blockquote, tables.
- Long content wraps in `Expandable` based on rendered height, not character count. Default closed state is `max-height: 320px` or roughly 16 lines of prose; beyond that the body shows "Show more". **This fixes the current silent-raw fallback without penalizing short code-heavy text.**
- Sanitize: raw HTML is stripped; only the elements listed above are allowed. Unknown tags render as escaped text rather than executing.

**Typography**
- h1: `--text-xl`, weight 600. Only at the top of a body.
- h2: `--text-lg`, weight 600, `--sp-5` top margin.
- h3: `--text-base`, weight 600, `--sp-4` top margin.
- p: `--text-md`, weight 400, `--sp-3` bottom margin.
- blockquote: `--text-md`, `--text-muted`, 3px `--border-strong` left border, `--sp-4` padding-left.
- Inline code: mono, `--text-sm`, `--surface-sunken` background, `--sp-1` horizontal padding, `--radius-xs`.
- `pre` code block: mono, `--text-sm`, `--surface-sunken` bg, `--sp-3` padding, `--radius-sm`.

**Rule:** Markdown code blocks and ToolCallBlock output use the **same** `--text-sm` mono, same padding, same surface. They are visually the same primitive. **This fixes the "same content looks different in two places" bug.**

### 4.18 CodeBlock

**Purpose** — Standalone code display (e.g., a skill body, a YAML config).

**Anatomy** — Optional header (language label + copy button) + pre block.

**Typography** — Same as Markdown's `pre`. Line numbers optional (off by default).

**Syntax highlighting** — Phase 3 (not v1). For v1, plain mono.

### 4.19 KeyValueList

**Purpose** — A table of meta rows (id, created, author, model, version, cost, duration).

**Anatomy** — Two-column grid: `auto 1fr` with `column-gap: --sp-3`. Keys are 11/caps/muted, values are 12/mono/text. Rows stacked with `row-gap: --sp-1`.

**Used in** — AdvancedMeta, Run summary metadata, Provider detail.

### 4.20 Banner

**Purpose** — Surface a single important in-context message without disrupting flow: stuck-task warning, save failure inline in the editor, mid-flow action failure. Banners sit inside a screen; Toasts (§4.9) sit outside it.

**Anatomy** — Full-width strip inside the screen's content column. `--sp-3` vertical padding, `--sp-4` horizontal, 1px left border in the kind's status color, tinted background. Leading icon (kind-specific, 16px) · body (title 13/500 + optional detail 12/muted, stacked) · trailing actions (at most two: a primary Button sm and/or a close IconButton).

**Variants**
- **warn** — `--status-review-bg-10` background, `--status-review` accent. Used for stuck-task banner (§5.2) and unsaved-changes reminders.
- **error** — `--status-error-bg-10` background, `--status-error` accent. Used for inline save-error (§5.6) and mid-flow action failures (§5.13).
- **info** — `--accent-soft` background, `--accent` accent. Used for one-time coach marks; never for important state.

**States** — default, action-pending (primary button shows spinner), dismissed (animates out with `wl-float-in` reverse).

**Do / Don't**
- Do anchor the banner to the surface whose state it describes. Stuck-task banner goes inside TaskDetail, not at page top.
- Do keep copy to one sentence plus at most two actions.
- Don't stack banners. If multiple conditions apply, collapse into a single "N issues" banner with a "Show all" expander.
- Don't use a Banner for a *successful* action result — that's a Toast.

**A11y** — `role="status"` for warn/info, `role="alert"` for error. The close IconButton has `aria-label="Dismiss"`. Primary action is focusable via Tab; Escape dismisses a non-critical banner but never an error banner.

---

## 5. Patterns

Patterns are the reusable interaction and state rules that cut across screens.

### 5.1 Task status state machine

**[Current] Backend truth (from `src/core/state-machine.js`):**

```
  todo ──run_requested──▶ in_progress
  in_progress ──run_completed──▶ in_review
  in_review ──review_approved──▶ done
  in_review ──review_rejected──▶ in_progress
  any ──human_move──▶ any  (backend allows; UI restricts — see below)
```

**Rule:** The four-state task model (`todo`, `in_progress`, `in_review`, `done`) is the baseline state machine. Red error affordances in the current product describe run failure or field/action error; they do **not** imply a fifth task state in the database.

**Visible groups in Commander** — the UI groups by *user mental model*, not by raw status:

- **Todo** — `status === "todo"` OR healthy `status === "in_progress"`. A row that is currently being run by a worker shows a `LivePulse` indicator; it does NOT live in its own "Running" group. The user's stated mental model: a task is either waiting/running, blocked, in review, or done.
- **Blocked** — synthesised. Includes any task with unmet `blocked_by` deps, OR `last_run.status === "error"`, OR stuck (`status === "in_progress" && is_locked === false`). Row chips disambiguate: `Blocked by N`, `Error`, `Stuck — reset`.
- **In review** — `status === "in_review"`.
- **Done** — `status === "done"`.

There is no separate "blocked" *status* in the database. Group membership is computed at render time by `groupKeyFor(task)` in `src/ui/src/routes/Commander.jsx`.

**UI transition policy** — The UI **must** expose the following transitions. This list is intentionally shorter than the backend's full matrix: we choose to keep the happy path linear while exposing escape hatches for recovery.

| From | To | UI control | Location | Confirm |
|---|---|---|---|---|
| todo | in_progress | "Run now" | TaskDetail toolbar, Commander row menu | — |
| todo | done | "Mark done" | TaskDetail status menu | — (server sets `completed_at`) |
| in_progress | todo | "Reset to todo" | TaskDetail status menu | yes — modal "Reset to todo? Active run will be cancelled." |
| in_progress | in_review | (automatic on run completion) | — | — |
| in_progress | done | "Mark done" | TaskDetail status menu | yes — modal "Mark done without review?" |
| in_review | in_progress | "Send back" | TaskDetail status menu | — |
| in_review | done | "Approve" | TaskDetail toolbar, primary action in-review | — |
| in_review | todo | "Reset to todo" | TaskDetail status menu | yes |
| done | todo | "Reopen" | TaskDetail toolbar | — |
| done | in_progress | (not exposed) | — | — |
| any | deleted | "Delete" | TaskDetail header | yes (ConfirmButton) |

**Implementation** — A single `StatusMenu` primitive (composed of Select-menu variant) hangs off the StatusPill on TaskDetail. Clicking the pill opens the menu with the currently-allowed transitions. Disabled transitions are hidden, not greyed-out — reduce cognitive load by showing only what's valid.

**This pattern is the fix for the stuck-in-progress bug.** The current UI exposes none of these transitions. With the menu, the user can move any `in_progress` task back to `todo` without curl.

### 5.2 Force-unlock (escape hatch)

A task is **stuck** when `status === "in_progress"` but no active worker exists (coordinator crashed, worker PID dead).

**Detection** — Driven solely by the `is_locked` boolean on the task-detail response. A task is stuck iff `task.status === "in_progress" && task.is_locked === false`. We do **not** infer "stuck" from timestamps or `last_run.end_at`, because inference produces false positives while a worker is alive but temporarily quiet. Until `is_locked` ships, the banner is not shown — the force-unlock affordance is held back rather than risking wrong diagnoses.

**Presentation** — A Banner (§4.20, warn variant) mounted at the top of TaskDetail's main column, below the hero:

> ⚠︎ This task shows as running but no worker is active.
> **[Reset]** **[Retry]**

**Actions**
- **Reset** — PATCH `/api/tasks/:id` with `{status: "todo"}`, toast on success, re-enables "Run now".
- **Retry** — same reset, then immediately `POST /api/tasks/:id/run`. One click for the common "I just want it to run again" case.

**[Requires backend]** — `GET /api/tasks/:id` must return a derived `is_locked: boolean` sourced from `coordinator.active.has(taskId)`. Tracked in §9.3.

### 5.3 Task error-chip policy

The current bug: `task.error_text` sticks across runs, showing "Error" on a task that just succeeded (principle: status must be the truth).

**Rule:** The UI treats `task.error_text` as a *transient* signal tied to the most recent run only. The error chip renders **only when `last_run.status === 'error'`**. Even if `task.error_text` is non-null, a successful subsequent run clears the visible error.

**Backend corollary** — The state machine should clear `error_text` on successful `run_completed`. **That's a backend fix** — the UI rule is defensive; the backend rule is correct.

### 5.4 Run state vs task state

Runs and tasks have separate state machines. The UI reflects this cleanly:

- **Task status** lives in StatusPill at the top of surfaces (row, detail hero, rail).
- **Run status** lives inside the Live Run Panel and in RunCard summary rows.
- Never conflate: a run may be `error` while its task is `in_progress` (the coordinator re-tries). A task may be `done` while no run is currently active.
- If a target-product `blocked` task state ever ships, it is still distinct from run error. A blocked task is a task-level decision, not a summary of the latest run.

**Rule:** StatusPill takes `task.status`. RunCard chip takes `run.status`. They are not the same component and not the same color source.

### 5.5 Live streaming contract

**Intent:** Every surface showing a running task pipes events through a single hook and a single render contract.

**Pipeline**
1. `useRunStream(runId)` fetches `/api/runs/:id` initial events, subscribes to `/api/runs/:id/stream` (EventSource).
2. Returns `{ events, done, loading, error }`.
3. Commander row consumes: takes the last 6 events, cycles them through `useLiveTicker(events, { intervalMs: 2200 })`, and renders the current tick as `ToolToken compact` in the row's live-line. When a new event arrives, the ticker advances to it immediately — the row always prefers showing the freshest activity over finishing the cycle.
4. TaskDetail LiveRunPanel consumes: full event list, renders `EventRow` per event, with `wl-tick-in` on newly-arriving rows. **Cinematic reveal is restored** — each new streaming event animates in; it does not batch-render on completion.

**[Requires backend] Running-run-id source** — The API response for a task **should** include `running_run_id: string | null` on list/detail responses if Commander owns live per-row stream previews. Today Commander references this field but the backend does not compute it. Preferred backend fix: compute `running_run_id = latest run where status === 'running'`.

**Completion** — Once `done === true`, the LivePulse disappears, `ShimmerBar` unmounts, the live-line in Commander collapses (56→44 height, 200ms transition), and the row looks idle.

### 5.6 Save-in-place (entity edits)

AgentEdit, SkillEdit, KbEdit, ProviderEdit.

**Rules**
- Autosave is **off** by default. User clicks Save. Ctrl/Cmd-S also saves.
- Dirty state: the Save button becomes primary (accent), remains secondary when clean.
- Leaving the surface with unsaved changes prompts via modal: "You have unsaved changes." Buttons: Discard / Keep editing / Save & leave.
- On save: toast "Saved." 2500ms. No page flicker.
- On save-error: banner inline at top of editor with error message and Retry button; do not use toast.

### 5.7 Create-flow (TaskEdit)

**Structure** — Full-page form. Sticky header (24px height, `--surface` with `--border` bottom) containing Back IconButton · Breadcrumb · spacer · "Cancel" ghost · "Create task" primary.

**Fields (baseline, visible by default)**
1. Title — required, Input, autofocus.
2. Description — Textarea, sans, autogrow.
3. Instructions — Textarea, mono, autogrow.
4. Executor — Select-menu (agent picker), optional at creation. Required before `Run now` is enabled on TaskDetail; the absence is a soft constraint at capture time, a hard constraint at execution time.
5. Reviewer — Select-menu (agent picker), optional.
6. Priority — Radio group: 0 / 1 / 2 / 3.
7. Tags — Tag input (comma-separated typed, rendered as chips).

**[Target] Extension fields**
8. Depends on — Select-menu (task picker), multi-select, only once the task graph ships.

**Advanced (twist-open)** — Reserved for fields the task model truly owns. Do not invent per-task system prompts or environment overrides ahead of backend/runtime support.

**Scope rule** — TaskEdit edits one task. There is no draft task state. Recurring templates do not live here; they live in Schedules.

**Primary action** — "Create task" (new) or "Save" (edit). Ctrl/Cmd-S triggers.

**Guard** — Unsaved-changes modal as in 5.6.

### 5.8 Search & filter bar

**Anatomy** — Sticky row at the top of a list surface. Left: SearchField with `[/]` hint. Center: filter Tabs (status, category, etc.). Right: primary CTA (e.g., "New task").

**Rules**
- Searching is local / client-side only; server filtering is opt-in via a `serverFilter` prop in future iterations.
- `/` focuses search globally (only when no input is focused).
- Clearing search: Escape, or click-X.
- Empty-after-filter uses `EmptyStateFiltered` with "Clear filters" button.

### 5.9 Keyboard shortcuts (global)

| Key | Action |
|---|---|
| `N` | New task (route to `#/tasks/new`). |
| `/` | Focus search on the current list when no text input or composer is already focused. |
| `?` | Open keyboard-help drawer. |
| `Esc` | Close the innermost dismissible surface; if no overlay is open and search is focused, clear it, then blur. |
| `⌘ S / Ctrl S` | Save the current editor. |
| `⌘ Enter` | Submit the focused composer/editor if one is active; otherwise trigger the primary action of the current screen. |
| `j / k` | Move selection in Commander when the Commander list owns focus. |
| `Enter` | Open selected row in Commander. |
| `x` | Toggle row checkbox in Commander (multi-select). |

The help drawer (`?`) lists every shortcut grouped by scope. All shortcuts are discoverable from there — **no hidden shortcuts**.

**Scope precedence**
- Global shortcuts are disabled while a modal or menu owns focus, except `Esc`.
- Text-entry surfaces win over list shortcuts. `j/k`, `x`, and `/` never fire from inside inputs, textareas, selects, or the comment composer.
- `⌘K` is reserved for a future quick-jump palette. It is not active until that feature ships.

### 5.10 Confirmation

Three patterns, in order of weight:

1. **Inline (ConfirmButton)** — Destructive button that arms on first click, commits on second within 2500ms. Used in-list for row-level deletes.
2. **Modal** — Modal 4.10 with explicit Cancel/Confirm buttons. Used for destructive task-level ops (Delete task, Reset to todo, Mark done without review).
3. **None** — Reversible ops do not confirm (toggle a switch, change a single non-destructive field, save a form).

### 5.11 Notifications (Toast policy)

Toast when:
- A user action succeeded with no other visible feedback (Saved, Deleted, Created).
- A background event affects the user's current context (e.g., "Task #abc completed").

Never toast for:
- Validation errors (use FormField error slot).
- Screen-level failures (use ErrorState).
- Non-actionable info (use status pill / chip).

### 5.12 Empty-content vs empty-after-filter

Two designs, never merged.

- **Empty content** — First-time or permanently empty. Warm, instructive. "Create your first agent" with primary CTA.
- **Empty after filter** — "No tasks match your filter." Secondary action: "Clear filters." No primary CTA — the user is inside a filtered context.

### 5.13 Error reporting

Three tiers, never mixed:

| Scope | Shape |
|---|---|
| Field-level validation | FormField's error slot. |
| Action-level backend failure | Toast (error variant) + inline banner if user is mid-flow. |
| Screen-level load failure | ErrorState with Retry. |

Never a raw stack trace. Never an inscrutable "Error: 500". Always a human-readable message; full detail in the console and Expandable behind "Show detail".

---

## 6. Screens

Every route has a blueprint.

### 6.1 Global — AppShell

**Purpose** — Persistent chrome: navigation rail, page header, content area, toast region.

**Layout**
- Rail — 240px fixed, `--surface`, `--border` right. Contains: logo/brand · nav list · quiet footer (version/build or secondary links only). No ambient live counts in global chrome.
- Header — 56px height, sticky, `--surface`, `--border` bottom. Contains: breadcrumb/title · optional headerMeta · primary action (New task on Commander, Save on edit screens).
- Main — scroll container.
- Toast region — fixed bottom-right.

**Data contract**
- On mount, subscribe to a global SSE channel for app-wide updates when the backend exposes one. Until then, each route manages its own live updates; the run-level `/api/runs/:id/stream` channel remains authoritative for run events. [Requires backend]

**Responsive** — Below 860px: rail collapses to a 56px bottom bar with icons.

**A11y** — Skip-link at top: "Skip to main content".

### 6.2 Commander `/#/tasks`

**Purpose** — See what's being worked on and what needs doing. Primary working surface.

**Primary action** — "New task" (in header).

**Layout**
- Filter bar: SearchField (`[/]`) · status Tabs (All · In review · Todo · Blocked · Done) · header right action ("New task").
- Group headers (one per visible group) — render inline at the top of their group, NOT sticky. Sticky positioning was overlapping rows during scroll.
- Commander rows (4.4).

**Group derivation** — see §5.1. The four visible groups (In review · Todo · Blocked · Done) come from `groupKeyFor(task)`. Tasks with `status === "in_progress"` appear inside Todo with a `LivePulse` indicator on the row; "in_progress" is treated as a transient worker-lifecycle state, not a sticky user-visible status. Tasks with unmet deps, last-run errors, or stuck workers land in Blocked.

**Inventory** — SearchField, Tabs, StatusPill, StatusDot, AgentAvatar, ToolToken, LivePulse, Commander row grid, EmptyState, LoadingState.

**Data contract**
- Fetches `GET /api/tasks` with optional `?status=` filter.
- Live updates: subscribe to a global `task_updated` SSE channel when available and live-upsert rows. Until that channel exists, refetch on window focus and optimistically upsert local mutations so user-initiated changes reflect immediately without a round-trip. [Requires backend]
- Per running row: prefer `task.running_run_id` for `useRunStream(...)`; until that field exists, derive the active run from the task's `runs` payload (latest run where status === "running").

**States** — default / loading (LoadingState) / empty (EmptyState "Create your first task") / empty-after-filter / error (ErrorState).

**Keyboard** — `/` focuses search; `N` routes to new-task; `j/k` move selection; `Enter` opens; `x` toggles checkbox.

**Responsive**
- 1440: columns as specified in 4.4.
- 1024: optional inline meta chips collapse first; title, agents, status, and age remain intact.
- 860: Commander switches to a two-line card per task: title + status on line 1, agents + age on line 2.

### 6.3 TaskDetail `/#/tasks/:id`

**Purpose** — Deep view of one task: see its definition, watch runs live, read and write comments, manage state and agents.

**Primary action** — Context-dependent:
- `todo` → "Run now" (primary, accent). Disabled with a tooltip ("Assign an executor to run") until an executor is set.
- `in_progress` and actively streaming (`is_locked === true`) → "Cancel run" (destructive-ghost).
- `in_progress` and stuck (`is_locked === false`) → "Retry" (primary). The stuck-task Banner (§5.2) remains the authoritative signal, but the toolbar mirrors it so the user can act from either location.
- `in_review` → "Approve" (primary) · "Send back" (secondary).
- `done` → "Reopen" (secondary).

**[Target] Extension** — If a task-level `blocked` state ships, its primary action is "Retry" or "Resolve blocker", but that is not part of the current four-state baseline.

**Layout** — Two-column, 1fr + 340px.

**Left column, top to bottom**
1. Breadcrumb: Tasks › #abc.
2. Hero: StatusPill · title (20/600) · meta line (mono 12 muted) with created-ago · primary action cluster.
3. `is_locked` banner (when detected — see 5.2).
4. Overview card — description first, instructions second. Instructions are collapsible if long and visually inset from prose.
5. Current run card — `LiveRunPanel` when a run is active. When idle, show the latest run summary collapsed by default.
6. Activity — unified feed merging comments and run milestones (run started · run completed · review requested · review approved/rejected · handoffs) on a single timeline. Composed client-side from the `comments` and `runs` arrays in the task-detail response; we do not need a separate backend endpoint for this. Full per-event streams live in the current-run card and in the Previous runs expander below — Activity is the narrative summary, not the raw log. Default to the newest 12 items with "Show older".
7. Comment composer.
8. Previous runs — collapsed expander below Activity. Default closed; opened only when the user needs historical depth.

**Right rail (340px, stacked cards)**
1. Agents — Executor avatar + name + role chip. Reviewer avatar + name + role chip. "Reassign" link on hover opens a Select-menu picker for each.
2. Details — KeyValueList: Created / Updated / Completed / Time in state, plus latest run metrics.
3. Tags — Chip list (editable inline).
4. Dependencies — "Blocked by" and "Blocks" lists, only once the task graph ships.
5. Actions — Buttons: Duplicate · Delete.

**Data contract**
- `GET /api/tasks/:id` on mount.
- Subscribe `task_updated` on SSE channel; re-fetch on event.
- `running_run_id` should drive LiveRunPanel mount when available; otherwise derive the current run from the returned `runs` payload.
- For each completed run shown: `useRunStream(run.id, { subscribe: false })` lazily on expand.
- Activity feed may be composed client-side from `comments + runs` on the current backend. Richer handoff/system items are additive, not required for the first pass.

**States** — loading / error / idle / live (LiveRunPanel present) / done (no LiveRunPanel, Reopen visible) / error-chip when `last_run.status === 'error'` (5.3).

**Keyboard** — `⌘Enter` triggers primary action. `E` opens edit.

**Responsive**
- 1024: rail narrows to 280px. The Details KeyValueList remains single-column (label / value). Agents card stacks executor and reviewer if the row would otherwise clip.
- 860: rail moves below the main column as a second scrollable block; tabs appear at the top of the left column ("Overview · Runs · Comments · Details").

### 6.4 TaskEdit `/#/tasks/new` and `/#/tasks/:id/edit`

**Purpose** — Create a task (new) or edit one task's metadata (edit). This screen is for task definition, not for recurring template management.

**Primary action** — "Create task" (new) / "Save" (edit).

**Layout** — Sticky header + centered content, 720px max-width. FormSections for Core (title · description · instructions) and Assignment (executor · reviewer · priority · tags). The Advanced twist-open is hidden whenever the task model has no advanced fields — on the current baseline it is always hidden. It reappears only if a future schema adds per-task overrides (e.g., custom system prompt, environment). Do not ship an empty twist-open.

**Data contract**
- New: `POST /api/tasks` on submit, redirect to `#/tasks/<newId>`.
- Edit: `GET /api/tasks/:id` on mount, `PATCH /api/tasks/:id` on submit, redirect back to detail.

**States** — idle · dirty (Save becomes primary) · saving (Save shows spinner, form disabled) · error (inline banner).

**Keyboard** — `⌘S` saves. `Esc` navigates back, with unsaved-changes guard.

**[Target] Extension** — Once the task graph ships, TaskEdit may add a dependency picker. Recurring templates still live in Schedules, not here.

### 6.5 Agents `/#/agents/:name?` + AgentEdit

**Purpose** — Configure the agents that Worklab can spawn.

**Primary action** — "New agent" (in pane header).

**Layout** — Pane (4.5). Left: SearchField, list of PaneRows (avatar, name, status dot, meta). Right: inline AgentEdit with toolbar (Save primary, Delete destructive) + FormSections (Identity · Runtime · Behavior · Capabilities · Advanced).

**Rules**
- Model selector uses Select-menu variant — same shape as AgentPicker. **This fixes the current AgentPicker-vs-SelectField divergence.**
- Reasoning effort: Radio group when capabilities list is 3–5; Select-menu otherwise. Conditional rendering when `reasoningMode === "none"` shows a muted placeholder: "This model does not support reasoning effort", not a blank gap.

**Data contract** — `GET /api/agents`, `GET /api/agents/:name`, `PATCH /api/agents/:name`, `DELETE`.

### 6.6 Skills `/#/skills/:slug?` + SkillEdit

**Purpose** — Manage reusable skill playbooks.

**Primary action** — "New skill".

**Layout** — Pane. Left: PaneRow shows dot + name + trigger chip + priority mini-badge + trailing "used by N". Right: SkillEdit with Metadata (display name, priority, enabled) · Trigger condition · Body (Markdown textarea).

**Data contract** — `GET /api/skills`, `/skills/:slug`, `PATCH`, `DELETE`.

### 6.7 Knowledge `/#/knowledge/:slug?` + KbEdit

**Purpose** — Shared context: references, how-to guides, policies, pinned snippets.

**Primary action** — "New entry".

**Layout** — Pane. Left: filter Tabs (All · Reference · How-to · Policy · Pinned) · PaneRow with category badge + title + pinned marker + age. Right: KbEdit with Metadata · Body.

**Data contract** — `GET /api/kb`, etc.

### 6.8 Providers `/#/providers/:name?`

**Purpose** — Configure LLM providers and enable/disable models.

**Primary action** — "New provider".

**Layout** — Pane. Left: PaneRow with type icon + name + status dot + "M models". Right: ProviderEdit — Identity (name, type, URL) · Auth (API key, masked) · Models (grid of model cards with enabled switch and capability chips).

**Data contract** — `GET /api/providers`, `POST /test`, `POST /discover`.

**Rule:** Provider type selector is a Radio group (segmented), not a grid of buttons. **This replaces the current ad-hoc flex-pill grid.**

### 6.9 Activity `/#/activity`

**Purpose** — Timeline of every run, ever.

**Primary action** — None (read-only).

**Layout** — Summary tiles at top (Total items · Running · Errors) · filter bar (agent, status, date range) · flat list of rows.

**Row anatomy** — AgentAvatar · title + target · mono timestamp · model · tokens · cost · StatusPill · "open run" Link.

**Data contract** — `GET /api/runs` with pagination.

### 6.10 Settings `/#/settings`

**Purpose** — Global system settings.

**Primary action** — "Save".

**Layout** — FormSections stacked: Consolidation · Execution · Search & embeddings. Save button in sticky header.

**Rule:** Every switch is rendered via the fixed Switch primitive (3.7) — no more description-wrapping-under-track. **This fixes the current settings misalignment.**

### 6.11 Schedules `/#/schedules` [Target]

**Purpose** — Manage recurring task templates. A schedule is a template plus cadence; each fire spawns a normal task instance.

**Primary action** — "New schedule".

**Layout** — Two-pane view. Left: dense schedule list with title, cadence chip, next fire, enable/pause state, and compact recent-run sparkline. Right: schedule detail with header, cadence editor, assignment, task template body, upcoming fires, and recent spawned tasks.

**Data contract**
- `GET /api/schedules` list with summary fields: `id`, `title`, `enabled`, `next_fire_at`, cadence summary, 30-day run summary.
- `GET /api/schedules/:id` detail with task template fields, agent assignment, recent spawned tasks, and upcoming fires.
- `POST /api/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`.
- `POST /api/schedules/:id/run` for manual spawn.

**States** — loading / empty / empty-after-filter / paused / enabled / error.

**Rule:** Schedule editing lives here, not in TaskEdit. TaskEdit may later offer "Convert to schedule template", but the lifecycle and editor live on the Schedules route.

---

## 7. Accessibility & responsive

### 7.1 Focus

- Every interactive element has a visible `:focus-visible` ring.
- Default ring: `outline: 2px solid var(--accent); outline-offset: 2px; border-radius: inherit`.
- Inputs replace the ring with a border color change (border → `--border-focus`).
- Hidden inputs (Switch, Checkbox) have their ring on the *visible* affordance (the track / the box).
- **Rule:** If you can't see the focus ring, the component fails review.

### 7.2 Keyboard

- Tab / Shift-Tab — cycles focus in DOM order.
- Enter — activates buttons and links; submits forms.
- Space — activates buttons; toggles checkboxes / switches.
- Arrow keys — Select menu navigation; Radio group; Tab-group; Commander row selection (j/k aliases).
- Escape — dismisses menus, modals, drawers; clears focused search.
- Every route supports `⌘Enter` for its primary action. Every editor supports `⌘S` for Save.

### 7.3 ARIA

| Primitive | Role | Required attributes |
|---|---|---|
| Button | `button` | `aria-label` if icon-only, `aria-pressed` for toggle buttons. |
| Select-menu | `combobox` on trigger, `listbox` on menu, `option` on rows | `aria-expanded`, `aria-activedescendant`. |
| Switch | `switch` | `aria-checked`. |
| Tab group | `tablist` / `tab` | `aria-selected`, `aria-controls`. |
| Modal | `dialog` | `aria-modal="true"`, `aria-labelledby`. |
| Toast | `status` (info/success) or `alert` (error) | — |
| Tooltip | `tooltip` | linked via `aria-describedby`. |
| StatusPill | decorative if redundant with text, else `aria-label="Status: Done"`. | — |

### 7.4 Contrast

All pairs meet at least WCAG AA at their used size. The token palette is tuned so `--text` on `--surface` passes AA-normal at 13px, and `--text-muted` on `--surface` passes AA-large at 14px. **Below 14px, `--text-muted` is forbidden**; use `--text`.

### 7.5 Responsive breakpoints

| Breakpoint | Screens affected | Changes |
|---|---|---|
| 1440 (default) | All | Base layout. |
| 1024 (laptop) | Commander, TaskDetail | Commander's inline meta chip in the title cluster (priority / blocked-by) collapses; title, agents, status, and age remain intact. TaskDetail rail narrows to 280px. |
| 860 (tablet) | All | Pane layouts become single-pane with back-nav. Commander row → two-line card. FormGrid → 1 column. |
| 390 (mobile) | All | Minimal density. Rail → bottom bar. All horizontal overflow forbidden. |

**Responsive rule:** Every screen must pass the `expectNoHorizontalOverflow` Playwright check at 390, 860, 1024, 1440.

### 7.6 Reduced motion

Under `prefers-reduced-motion: reduce`:
- `wl-pulse` → static 0.6-alpha ring.
- `wl-shimmer` → 1px accent static line.
- `wl-tick-in`, `wl-float-in` → instant opacity 1.
- `wl-caret`, `wl-confirm-pulse` → stopped.
- Menu/drawer transitions → 50ms (snap open).

---

## 8. Glossary & naming

### 8.1 Token naming

`--<category>-<role>-<variant?>`

- Category: `bg`, `surface`, `text`, `border`, `accent`, `status`, `font`, `sp`, `text` (size), `radius`, `elev`, `dur`, `ease`.
- Role: role within the category (`elevated`, `muted`, `progress`, `pill`, etc.).
- Variant: optional (`bg-10`, `bg-20`, `border`).

Examples: `--surface-elevated`, `--text-muted`, `--status-progress-bg-10`, `--dur-snap`, `--ease-std`.

### 8.2 File naming

- `src/ui/src/components/primitives/<Name>.jsx` — one primitive per file.
- `src/ui/src/components/<Name>.jsx` — composites.
- `src/ui/src/routes/<Name>.jsx` — screens.
- `src/ui/src/lib/<camelName>.js` — hooks and utilities.

### 8.3 CSS class convention

Flat, semantic, kebab-case, no BEM. Classes match the component name: `.commander-row`, `.pane-detail`, `.status-pill`. Variant suffixes are space-separated classes: `<div class="button primary">`, `<div class="card card-spacious">`.

### 8.4 Screen-reader-only text

`.sr-only` — `position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)`. Used when a visual element carries meaning a screen reader would miss (e.g., an icon-only button's label is baked into `aria-label`, not `.sr-only`; but an icon that extends meaning beyond its label gets `.sr-only` context).

---

## 9. Appendix

### 9.1 Known functional defects — design response

A running list of user-reported bugs and the document's response. Each entry links to the section that specifies the fix.

| Defect | Design response |
|---|---|
| Status pill overlaps Commander row content | Commander row (§4.4) reserves a 104px column for the pill; StatusPill (§3.11) is container-width-driven and truncates cleanly at the cell boundary. Overflow is structurally impossible. |
| SwitchField label / description run into each other | Switch (§3.7) replaces `margin-top: 2px` on the track with `align-self: start`. Track anchors to label x-height regardless of description wrap. |
| Model selector looks different from AgentPicker | Select primitive (§3.6) unifies both. SelectField and AgentPicker are both replaced by `Select variant="menu"` with a role-specific `leadingSlot`. Trigger is 32px everywhere. |
| Log rendering is inconsistent / weird | EventRow (§4.15) defines a single typography contract for every event type. All monospaced content is `--text-sm` (12px). Markdown code blocks and ToolCallBlock output share one `pre` style (§4.17). |
| Task stuck in `in_progress` with no UI to recover | Status menu (§5.1) exposes every allowed transition including `in_progress → todo`. Stuck-task Banner (§5.2) detects `is_locked === false` and offers Reset / Retry. |
| Error chip shown despite successful run | §5.3: error chip binds to `last_run.status === 'error'`, not to `task.error_text`. Paired backend fix (§9.3) clears `error_text` on a successful `run_completed`. |
| Live logs missing on TaskDetail | LiveRunPanel (in §6.3) + live streaming contract (§5.5) specify cinematic event reveal via `wl-tick-in` per new row. |
| Blocked-by dependencies not visible | Commander row (§4.4) surfaces a compact `Blocked by N` chip in its own grid cell, and the row moves into the synthesized **Blocked** group (§6.2). TaskDetail rail (§6.3) has a Dependencies card. |
| Keyboard shortcuts not discoverable | `?` opens a drawer listing every shortcut (§5.9). No hidden shortcuts. |
| Long task text silently drops Markdown | Markdown (§4.17) clamps body by rendered height and offers "Show more"; full Markdown is never dropped. |
| No inline affordance for action failures | Banner (§4.20) is the canonical inline message. Stuck-task (§5.2), save-error (§5.6), and mid-flow failures (§5.13) all resolve through it. |

### 9.2 Migration notes

When the implementation phase begins, here is the file-level map from rules → current files.

| Rule | Current file(s) to update |
|---|---|
| Unified Select primitive | Merge `SelectField.jsx` + `AgentPicker.jsx` → `primitives/Select.jsx`. Update `AgentEdit.jsx`, `TaskEdit.jsx`, `Providers.jsx`, `Settings.jsx`, `Knowledge.jsx`, `Skills.jsx`. |
| Switch alignment | `SwitchField.jsx` — change track `margin-top` to `align-self: start`. Remove the 2px offset in `styles.css` §710–774. |
| Commander row simplification | `Commander.jsx`, `StatusPill.jsx`, `styles.css` — lock the 7-column row contract and collapse the supplementary meta chip (priority/blocked-by) before core columns. |
| EventRow typography | `AgentEventTimeline.jsx`, `EventTimeline.jsx`, `ToolCallBlock.jsx`, `Markdown.jsx` — route content typography through the same mono/sans scale. Remove all 10.5 / 11.5 / 12.5 px occurrences from `styles.css`. |
| Status menu on TaskDetail | New `StatusMenu.jsx` composite in `components/`, wired into the `TaskDetail.jsx` hero. Hangs off the StatusPill using the Select-menu variant. |
| Stuck-task Banner | `TaskDetail.jsx` — mount a warn Banner (§4.20) when `is_locked === false && status === "in_progress"`. Actions: Reset, Retry. |
| Error-chip policy | `TaskDetail.jsx`, `Commander.jsx` — derive error chip from `last_run.status === 'error'`, not from `task.error_text`. |
| TaskDetail consolidation | `TaskDetail.jsx`, `EventTimeline.jsx`, new `LiveRunPanel.jsx` — unify Overview + Current run + Activity; keep Previous runs as a collapsed expander below. |
| Activity feed composition | `TaskDetail.jsx` — client-side merge of `comments[]` and `runs[]` milestone events into a single timeline per §6.3. No new API endpoint. |
| Live-reveal on TaskDetail | New `LiveRunPanel.jsx` that accepts `{ run, events, isStreaming }` and animates each incoming event via `wl-tick-in`; replaces the bulk-render path in `EventTimeline`. |
| Markdown Expandable | `Markdown.jsx` — render full Markdown for every length; clamp body to `max-height: 320px` by default with a "Show more" toggle. Remove the current character-based silent fallback. |
| Banner composite | New `components/Banner.jsx` per §4.20. Consumed by stuck-task, save-error, and mid-flow action failures. |
| Dependencies UI [Target] | `TaskDetail.jsx`, `TaskEdit.jsx`, `Commander.jsx` — only after the task graph ships (§9.3). Do not mount placeholder UI before relations land. |
| FormField / FormSection / FormGrid promotion | New `components/FormField.jsx`, `FormSection.jsx`, `FormGrid.jsx`. `AgentEdit`, `SkillEdit`, `KbEdit`, `TaskEdit`, `Settings`, `Providers` all migrate. |
| Breadcrumb extraction | New `primitives/Breadcrumb.jsx`. `TaskDetail.jsx`, `TaskEdit.jsx`, `AgentEdit.jsx`, etc. use it. |
| Keyboard help drawer | New `components/KeyboardHelpDrawer.jsx`. Triggered on `?` globally. |
| Schedules route [Target] | New `routes/Schedules.jsx` plus schedule editor / detail composites and matching API routes. |
| Reduced-motion support | `styles.css` — add `@media (prefers-reduced-motion: reduce)` block implementing §2.6.3 and §7.6. |
| 390px overflow pass | `ui-regressions.spec.js` — update selectors to match the new Commander row, LiveRunPanel, and Banner. Ensure zero horizontal overflow at 390, 860, 1024, 1440. |

### 9.3 Backend and data changes this document requires

**Current-baseline improvements**

1. **`running_run_id` on task responses.** `GET /api/tasks/:id` and `GET /api/tasks` should include a derived field `running_run_id: string | null` if Commander owns per-row live stream previews.
2. **`is_locked` on task detail responses.** For force-unlock detection, `GET /api/tasks/:id` should include `is_locked: boolean` sourced from `coordinator.active.has(taskId)`.
3. **Clear `error_text` on successful `run_completed`.** `state-machine.js` currently clears `error_text` only on `review_rejected`. Add it to `run_completed` too so a successful run wipes prior error state.

**[Target] Product extensions**

4. **Task graph.** Dependencies require relation storage plus task-summary arrays on task responses (`blocked_by`, `blocks`, or equivalent). Commander only needs compact counts/linked titles; TaskDetail needs linked task summaries.
5. **Schedules.** Schedules require a dedicated entity, cadence parser/storage, `next_fire_at`, `enabled`, recent-fire history, and a link from spawned tasks back to their schedule.
6. **Blocked task state, if adopted.** If product ships a task-level blocked/error state, add it explicitly to schema and state machine as `blocked`. Do not derive it from run failure text.

**Explicit non-requirement**

- Archive is intentionally **not** a required backend change in this document until archive lifecycle and retrieval semantics are designed.

### 9.4 Locked decisions

The following decisions are now part of the schema:

1. The document is a split spec: stable foundations plus explicit current/target/backend markers where behavior diverges.
2. The baseline task model remains four-state. Prototype blocked/error behavior is treated as a future explicit `blocked` state, not as implied current truth.
3. Commander stays dense, but the row contract is simplified. Title, agents, status, and age are protected; supplementary chips collapse first.
4. Markdown expands by rendered height, not raw character count.
5. Reduced-motion support applies to the full motion system, not just pulse/shimmer.
6. Avatar hue derives from stable agent identity (`name` today), never from editable display labels.
7. Two-pane editors keep modal unsaved-change guards.
8. Global rail chrome stays quiet; live task counts belong on task surfaces, not in the app shell footer.
9. Archive is removed from the baseline task spec until lifecycle semantics are defined.

### 9.5 What's explicitly out of scope for v1 / current shipped implementation

- Light mode.
- Syntax highlighting in CodeBlock.
- `⌘K` quick-jump palette (Phase 3).
- Archive lifecycle and archived-task views.
- Mobile polish below 390px.
- Internationalization of labels.
- Saved filter/view presets on Commander.
- Shipping the Schedules route in the current app without its dedicated backend model.

---

*End of schema. Section numbers are stable references — treat them as API.*
