# npm Release

Worklab publishes from one repo tag to all public npm packages:

```bash
npm install -g @worklab-ai/worklab
worklab start
```

The release workflow publishes every non-private package that has
`publishConfig`, currently:

- `@worklab-ai/agent-runtime`
- `@worklab-ai/webhooks`
- `@worklab-ai/worklab`

## One-Version Rule

The tag is the source of truth. For tag `vX.Y.Z`:

- The root package version must be `X.Y.Z`.
- Every publishable workspace package version must be `X.Y.Z`.
- Internal dependencies between publishable packages must be exact `X.Y.Z`
  versions, not ranges.

The private example workspace is not published.

## GitHub Setup

Add a repository secret named `NPM_TOKEN`. Use a granular npm token with publish
access to every `@worklab-ai/*` package in this repo.

## Release

Prepare the next version locally:

```bash
VERSION=0.1.6
npm pkg set version="$VERSION"
npm pkg set version="$VERSION" --workspace packages/agent-runtime
npm pkg set version="$VERSION" --workspace packages/webhooks
npm pkg set "dependencies.@worklab-ai/agent-runtime=$VERSION"
npm pkg set "dependencies.@worklab-ai/webhooks=$VERSION"
npm install --package-lock-only
```

Run the same local gates used by the workflow:

```bash
npm run release:validate -- --tag "v$(node -p "require('./package.json').version")"
npm test
npm run build:ui
npm run pack:check
npm pack --workspace packages/agent-runtime --dry-run --json
npm pack --workspace packages/webhooks --dry-run --json
git diff --check
```

Commit and push the version change, then create one repo tag:

```bash
git push origin main
git tag "v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```

The `npm release` GitHub Actions workflow publishes missing package versions in
dependency order and skips versions that already exist, so rerunning the same
tag is safe.

## Post-Publish Smoke

The workflow verifies public metadata, installs the CLI from npm with a clean
npm config, runs `worklab --help`, starts `worklab serve` with a temporary data
directory, and checks `/api/health`.

Manual smoke command:

```bash
TMP_PREFIX="$(mktemp -d)"
NPM_CONFIG_USERCONFIG=/dev/null npm install -g --prefix "$TMP_PREFIX" @worklab-ai/worklab@latest
"$TMP_PREFIX/bin/worklab" --help
```
