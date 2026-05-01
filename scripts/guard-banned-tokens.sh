#!/usr/bin/env bash
# guard-banned-tokens.sh
# Enforces the token constraints documented in docs/ui-design-system.md inside src/ui.
# Fails with exit 1 on any violation. Intended for CI and local pre-commit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIR="$ROOT/src/ui/src"
STYLES="$UI_DIR/styles.css"

fail=0
report() {
  echo "::guard-banned-tokens:: $1"
  fail=1
}

# 1. Banned pixel font sizes (§2.2.1): 10.5, 11.5, 12.5, 13.5 in px context
if grep -rnE '(10|11|12|13)\.5px' "$UI_DIR" --include='*.css' --include='*.jsx' --include='*.js' >/dev/null; then
  report "banned half-px sizes detected (10.5 / 11.5 / 12.5 / 13.5 px)"
  grep -rnE '(10|11|12|13)\.5px' "$UI_DIR" --include='*.css' --include='*.jsx' --include='*.js' || true
fi

# 2. Raw hex colors outside the :root token block in styles.css (§2.1).
# We strip the first :root {...} definitions block, then hunt for #abc/#abcdef.
awk '
  BEGIN { inroot=0 }
  /^:root/ { inroot=1 }
  inroot && /^}/ { inroot=0; next }
  !inroot { print NR":"$0 }
' "$STYLES" | grep -E '#[0-9a-fA-F]{3,8}\b' && { report "raw hex outside :root in styles.css"; } || true

# 3. Off-spec border-radius values (only 2, 6, 10, 999 px, or radius tokens allowed).
if grep -rnE 'border-radius:\s*(3|4|5|7|8|12|14|16|20|24)px' "$UI_DIR" --include='*.css' --include='*.jsx' --include='*.js' >/dev/null; then
  report "off-spec border-radius px values (must use --radius-xs/sm/md/pill)"
  grep -rnE 'border-radius:\s*(3|4|5|7|8|12|14|16|20|24)px' "$UI_DIR" --include='*.css' --include='*.jsx' --include='*.js' || true
fi

if [ "$fail" -eq 1 ]; then
  echo "guard-banned-tokens: FAIL"
  exit 1
fi
echo "guard-banned-tokens: OK"
