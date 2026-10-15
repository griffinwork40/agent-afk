#!/bin/sh
# Thin wrapper — delegates to the TypeScript runner.
# All flags are forwarded unchanged.
#
# Usage (same flags as before):
#   ./scripts/run-workspace-ab-test.sh [--model sonnet] [--dry-run] [--trials 5]
#
# The TypeScript runner is the canonical implementation; see:
#   scripts/run-workspace-ab-test.ts
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node --import tsx/esm "$REPO_ROOT/scripts/run-workspace-ab-test.ts" "$@"
