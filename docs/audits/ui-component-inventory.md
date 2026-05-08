# UI Component Inventory

> Status: current as of 2026-05-08
> Scope: `src/ui/src/components` and `src/ui/src/routes`

This audit is the current map for Worklab UI component ownership. The rule is
simple: reusable UI belongs under `src/ui/src/components`, while route-local
components are allowed only when they are single-owner compositions tied to one
route's data shape, actions, or copy.

## Current baseline

Inventory command: scan `src/ui/src/components` and `src/ui/src/routes` for
PascalCase function and arrow declarations, filtering out all-caps constants.

| Area | Count | Purpose |
| --- | ---: | --- |
| Shared components | 93 | Cross-route domain UI, entity chrome, resource rows, feedback, structured content, shell pieces, and reusable selectors. |
| Layout components | 22 | Shared page, detail, edit, workflow, toolbar, grid, and stack structure. |
| Primitive components | 34 | Buttons, form controls, badges, chips, tokens, tabs, tooltips, and other low-level controls. |
| Route-local components | 73 | Single-route compositions that bind shared primitives/layouts to route-specific data, mutation flows, and labels. |
| Route files with locals | 22 | Routes still own local composites only where no second owner exists. |
| Duplicate component names | 0 | Enforced by `src/__tests__/ui/design-system.test.js`. |

## Shared component purposes

| Group | Files | Reuse contract |
| --- | --- | --- |
| Primitives | `components/primitives/*` | Low-level controls and tokens. These should never duplicate route-local spans/buttons/selects when the primitive can express the same behavior. |
| Layout | `components/layout/*`, `Card`, `PaneLayout`, `PaneRow`, `FormGrid`, `FormSection` | Shared structure for pages, detail panes, editors, resource lists, cards, toolbars, stacks, and workflow sections. |
| Resource lists | `ResourceListToolbar`, `ResourceRowMeta`, `SearchField`, `PaneRow` | Compact list/detail controls and row metadata shared by Projects, Agents, Skills, Knowledge, Goals, Teams, Providers, and Commander-like surfaces. |
| Entity chrome | `EntityHeader`, `EntityMetaList`, `EntityChromeBridge`, `AdvancedMeta`, `KeyValueList`, `Metric` | Reusable object headers, metadata blocks, stats, and key/value presentation. |
| Feedback and state | `Banner`, `EmptyState`, `ErrorState`, `LoadingState`, `Toast`, `Modal`, `Drawer`, `ConfirmButton` | Shared status, confirmation, and blocking-state UI. |
| Agent/task runtime | `AgentEventTimeline`, `EventTimeline`, `EventRow`, `LiveRunPanel`, `RunHistoryNotice`, `ToolCallBlock`, `StructuredValue`, `StructuredContent`, `GoalContractDetails` | Shared runtime, structured-output, run-log, and goal-contract presentation across task, team, goal, and design-system surfaces. |
| Selectors and editors | `AgentPicker`, `TeamPicker`, `FileTree`, `FormField`, `SelectField`, `SwitchField`, `CheckboxField` | Reusable picker and field wrappers that keep form semantics consistent. |
| Shell | `AppShell`, `AssistantDock`, `KeyboardHelpDrawer`, `MobileConfigSheet`, `StatusMenu` | Global shell components with app-wide behavior. |

## Route-local components that intentionally remain local

| Route file | Local components | Reuse decision |
| --- | ---: | --- |
| `routes/task-detail/RunCards.jsx` | 13 | Task-run cards are tightly coupled to task-run diagnostics, artifacts, budget, verification, and failure details. Keep local until another route needs the same run-card contract. |
| `routes/Teams.jsx` | 9 | Team setup, member editing, lead-cycle rows, and dashboard cards are team-specific compositions using shared cards, fields, grids, and goal contract details. |
| `routes/task-detail/WorkflowCards.jsx` | 8 | Task workflow panels are task-detail-specific and bind task context, plan, subtasks, automations, and agent rail data. |
| `routes/Projects.jsx` | 7 | Project detail, task progress, and attention chips are project-specific compositions. Shared row/list primitives already carry the common layout. |
| `routes/settings/components.jsx` | 5 | Settings panels and notes are route-specific admin layout helpers layered on shared form/layout primitives. |
| `routes/Goals.jsx` | 4 | Goal row/detail/editor wrappers stay local; the reusable goal contract display has been hoisted. |
| `routes/Commander.jsx` | 3 | Commander orchestration controls stay local because they combine bulk task state, stage filters, runtime groups, and route commands. Shared selector/list primitives handle common UI. |
| `routes/DesignSystem.jsx` | 3 | Catalog-only fixtures and coverage presentation stay local to the catalog route. |
| `routes/KbDetail.jsx` | 3 | Relation and usage lists are tied to KB detail payload shape. |
| `routes/Providers.jsx` | 3 | Provider pricing and editor wrappers are provider-route specific. |
| Other route files | 1-2 each | Route shell or editor wrappers only; no reusable second owner currently exists. |

## Hoisted or unified in this pass

- `GoalContractDetails` moved from duplicated route-local definitions in
  `Goals.jsx` and `Teams.jsx` to `src/ui/src/components/GoalContractDetails.jsx`
  and is now visible in the design-system catalog.
- `StructuredValue` no longer defines its own `Badge`; its local
  `StructuredBadge` wraps the shared primitive badge and preserves the compact
  structured-output styling.
- `src/__tests__/ui/design-system.test.js` now fails if a PascalCase component
  name appears in more than one shared or route-local UI file.

## Reuse policy

1. Add a new UI primitive only under `components/primitives` when it is a
   low-level control with no domain data dependency.
2. Add reusable route-facing pieces under `components` when two or more routes
   need the same presentation contract or when a route-local component's purpose
   is not route-specific.
3. Keep route-local components local when they are single-owner compositions
   over one route's payload, action set, and copy.
4. If a local component needs the same CSS/markup purpose as an existing shared
   component, wrap or extend the shared component instead of recreating markup.
5. Run `npx vitest run src/__tests__/ui/design-system.test.js` after adding or
   moving UI components; it guards catalog coverage and duplicate component
   declarations.

