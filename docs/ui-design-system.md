# Worklab UI Design System

This file is the written contract for Worklab's shared UI system. The live
catalog at `#/design-system`, `src/ui/src/styles.css`, and the tests in
`src/__tests__/ui/design-system.test.js` are the executable sources of truth.

## Source Of Truth

- `src/ui/src/styles.css` owns design tokens, responsive rules, and shared
  class contracts.
- `src/ui/src/components/primitives/` owns low-level controls such as buttons,
  inputs, status tokens, tabs, and domain inputs.
- `src/ui/src/components/layout/` owns reusable page, detail, rail, toolbar,
  and workflow layouts.
- `src/ui/src/components/*.jsx` owns reusable composed components used across
  routes.
- `src/ui/src/routes/DesignSystem.jsx` must represent every shared component
  either with a visible example or with an explicit shell-hosted coverage note.

Route-local helpers are not design-system components until they move under
`src/ui/src/components`.

## Tokens

All shared UI styles should use tokens from `:root` in `styles.css`.

- Colors: use semantic tokens such as `--surface`, `--text`, `--accent`, and
  `--status-*`; do not add raw hex outside the token block.
- Typography: use `--text-*` and family tokens. Do not scale font size with
  viewport width. Letter spacing must stay at zero or positive tracking,
  including structural serif headings.
- Spacing: use `--sp-*` tokens.
- Radii: use `--radius-xs`, `--radius-sm`, `--radius-md`, or
  `--radius-pill`.
- Motion: use `--dur-*`, `--ease-*`, and the shared keyframes.

`scripts/guard-banned-tokens.sh` enforces the highest-risk token drift.

## Typography Roles

Three families, three jobs:

- **Instrument Serif** (`--font-display`): page and detail hero headings only
  (`.h-page`, `.h-entity-lg`). It should not be used for dense list rows.
- **Manrope** (`--font-sans`): body, descriptions, dense UI lines, buttons.
  Operational rows use `--font-sans` so task and resource lists stay scannable.
- **JetBrains Mono** (`--font-mono`): eyebrows, IDs, ages, the live-run stream,
  `--text-subtle` metadata.

Avoid inventing a fourth role — extend or rename the three above instead.

## Chips

Five canonical variants. One purpose each. If a new chip doesn't fit a rule,
the rule changes — not a sixth variant.

| Variant | `Chip variant=` | CSS class | Purpose |
|---------|-----------------|-----------|---------|
| Tag | `muted` | `chip-muted` | Categorical identity (project, type). |
| Link | `accent` | `chip-accent` | Relationship to another entity; click implies navigate. |
| Pending | `warn` | `chip-warn` | Soft amber; non-blocking attention. |
| Alert | `error` | `chip-error` | Coral; only one per row. |
| Inline meta | `inline` | `chip-inline` | Borderless, transparent, `--text-subtle`. Use for automation, schedule, secondary categorical info. |

**Rule of one alert.** Per row / hero, surface only the highest-priority alert
chip (`stuck > error > 2+ blocking > N actions > needs-owner`); tooltip the rest.

## Component Coverage

The design-system catalog should stay one-to-one with the shared component
surface:

- Every exported primitive component is represented.
- Every exported layout component is represented.
- Every reusable root-level component is represented or explicitly marked as
  shell-hosted when rendering it standalone would duplicate global app chrome.
- Pure helper exports can be excluded when they are not components, but the
  component that exposes their behavior should still be covered.

When adding, renaming, or deleting a shared component, update the catalog and
the parity tests in the same change.

## Responsive Rules

Shared components must avoid horizontal overflow at the Playwright viewport
matrix used by `src/__tests__/playwright/ui-regressions.spec.js`.

Mobile-specific rules should preserve compact Worklab density:

- Keep action controls reachable without crowding primary content.
- Let metadata and badges wrap before they crowd out titles.
- Keep tool-call labels and values inline with truncation instead of vertical
  letter wrapping.
- Avoid adding route-local responsive fixes when the issue belongs to a shared
  primitive or layout component.

## Update Workflow

1. Add or update the shared component.
2. Add a visible catalog example or shell-hosted coverage note in
   `DesignSystem.jsx`.
3. Update tests if the exported component surface changed.
4. Run the focused design-system test, `npm run build:ui`, and the relevant
   Playwright route checks for visual or responsive changes.
