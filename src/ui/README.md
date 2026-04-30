# `src/ui/` — Preact + Vite Web App

Browser bundle served by the API. Separate from the Node side of the
codebase — no Node imports, no DB imports, no coupling to `src/core/`.

The bundle is built into `src/ui/dist/` by `npm run build:ui` and served
statically by `src/api/server.js`. `npm run dev:ui` runs Vite with HMR and
proxies `/api` to whatever `dev:api` is on (defaults to port 4280).

## Layout

```
src/ui/
├── vite.config.js
├── index.html
├── public/
└── src/
    ├── App.jsx
    ├── main.jsx
    ├── styles.css                 # design-token block (guard-banned-tokens.sh)
    ├── routes/                    # page-level Preact components
    ├── components/
    │   ├── primitives/            # form inputs, badges, tokens
    │   └── layout/                # page shells, detail panes
    └── …
```

## Design system

`docs/ui-design-system.md` and `scripts/guard-banned-tokens.sh` enforce
spacing/typography tokens. Stick to the variables defined in `styles.css`
and the primitives under `components/primitives/` rather than introducing
new variants.

## Modularization scope

The UI is **not** part of the modularization plan's restructuring. It will
gain a public-API barrel only insofar as Preact code is concerned; the
Node-side rules above already exclude it.
