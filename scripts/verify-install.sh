#!/usr/bin/env bash
# verify-install.sh — Manual smoke-test for the zero-friction macOS install UX.
#
# Scenarios:
#   1. PATH gap detection: postinstall prints remediation banner
#   2. dist/postinstall.mjs artifact exists (build-time check)
#   3. postinstall.mjs exits 0 unconditionally (no crash on error path)
#
# Usage: bash scripts/verify-install.sh
# Prints PASS/FAIL per scenario and exits non-zero if any fail.

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== verify-install.sh ==="
echo ""

# ─── Scenario 1: PATH gap detection ──────────────────────────────────────────
echo "Scenario 1: PATH gap detection (postinstall prints remediation banner)"

# Use a temp directory as the fake npm prefix.
FAKE_PREFIX=$(mktemp -d)
FAKE_BIN="${FAKE_PREFIX}/bin"
mkdir -p "$FAKE_BIN"

# Build a PATH that includes normal tools but NOT the fake bin dir.
# We use the real PATH so that node and npm are accessible, but remove
# any entry that matches FAKE_BIN to simulate a PATH gap.
SAFE_PATH="$(echo "$PATH" | tr ':' '\n' | grep -v "^${FAKE_BIN}$" | tr '\n' ':' | sed 's/:$//')"

output=$(
  PATH="$SAFE_PATH" \
  npm_config_prefix="$FAKE_PREFIX" \
  node scripts/postinstall.mjs 2>/dev/null
)
exit_code=$?

if echo "$output" | grep -q "export PATH"; then
  pass "remediation banner contains 'export PATH'"
else
  fail "remediation banner NOT printed or missing 'export PATH' (exit=$exit_code, output='$output')"
fi
rm -rf "$FAKE_PREFIX"

# ─── Scenario 2: dist/postinstall.mjs exists ─────────────────────────────────
echo ""
echo "Scenario 2: dist/postinstall.mjs exists after build"
if [ -f "dist/postinstall.mjs" ]; then
  pass "dist/postinstall.mjs exists"
else
  fail "dist/postinstall.mjs NOT found (run 'npm run build:dist' first)"
fi

# ─── Scenario 3: postinstall exits 0 unconditionally ────────────────────────
echo ""
echo "Scenario 3: node scripts/postinstall.mjs exits 0"

node scripts/postinstall.mjs > /dev/null 2>&1
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  pass "postinstall.mjs exits 0"
else
  fail "postinstall.mjs exited with code $exit_code (expected 0)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
