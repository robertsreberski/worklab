# npm Release

Worklab publishes as a scoped public CLI package:

```bash
npm install -g @worklab-ai/worklab
worklab start
```

The global executable remains `worklab`. The CLI package depends on the public
runtime package `@worklab-ai/agent-runtime`, so publish the runtime first.

## Preflight

```bash
git status --short --branch
npm test
npm run build:ui
npm run pack:check
npm pack --workspace packages/agent-runtime --dry-run --json
git diff --check
```

Confirm the package names are still unpublished or show the intended version:

```bash
npm view @worklab-ai/agent-runtime version
npm view @worklab-ai/worklab version
```

Authenticate before publishing:

```bash
npm login
npm whoami
```

## Publish

```bash
npm publish --workspace packages/agent-runtime --access public --dry-run
npm publish --workspace packages/agent-runtime --access public
npm publish --access public --dry-run
npm publish --access public
```

## Post-Publish Smoke

Use a clean terminal or temporary global prefix:

```bash
npm view @worklab-ai/worklab version bin dependencies
npm install -g @worklab-ai/worklab
worklab --help
WORKLAB_DATA_DIR="$(mktemp -d)" WORKLAB_PORT=9787 worklab serve
curl http://127.0.0.1:9787/api/health
```

Then tag and push the release:

```bash
git tag v0.1.0
git push origin HEAD
git push origin v0.1.0
```
