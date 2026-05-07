#!/usr/bin/env bash
# Pre-commit-friendly boundary check. Runs ESLint on src/ with only the
# layer-import rules, then prints the count. Fast-fails on errors; warnings
# are listed but don't block. Promote rules in eslint.config.js to "error"
# once the layer leaks are cleaned up.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! npx --no-install eslint --version >/dev/null 2>&1; then
  echo "guard-imports: eslint not installed; run 'npm install' first." >&2
  exit 2
fi

output=$(npx --no-install eslint src packages --rule '{"no-restricted-imports":"error"}' 2>&1 || true)
echo "$output"
echo
errors=$(printf '%s\n' "$output" | grep -E "^✖ [0-9]+ problems" | head -1 || true)
if [[ -z "$errors" ]]; then
  echo "guard-imports: clean."
  exit 0
fi
if printf '%s\n' "$output" | grep -q "[0-9]\+ errors"; then
  exit 1
fi
exit 0
