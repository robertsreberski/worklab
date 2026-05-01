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
  viewport width and do not use negative letter spacing.
- Spacing: use `--sp-*` tokens.
- Radii: use `--radius-xs`, `--radius-sm`, `--radius-md`, or
  `--radius-pill`.
- Motion: use `--dur-*`, `--ease-*`, and the shared keyframes.

`scripts/guard-banned-tokens.sh` enforces the highest-risk token drift.

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
