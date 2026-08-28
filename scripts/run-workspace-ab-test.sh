#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Shared Agent Workspace A/B Experiment
# ─────────────────────────────────────────────────────────────────────────────
#
# Runs the SAME multi-agent task twice:
#   ARM A (control):   AFK_WORKSPACE_DISABLED=1  — agents work in full isolation
#   ARM B (treatment): AFK_WORKSPACE_DISABLED unset — shared workspace enabled
#
# After both runs, measures cross-agent file-read deduplication and compares.
#
# Usage:
#   ./scripts/run-workspace-ab-test.sh [--model sonnet] [--dry-run]
#
# Output: scripts/ab-results/ with per-arm traces and a comparison report.
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AFK_BIN="$REPO_ROOT/dist/cli/index.js"
MEASURE_SCRIPT="$REPO_ROOT/scripts/measure-read-dedup.ts"
RESULTS_DIR="$REPO_ROOT/scripts/ab-results"
MODEL="sonnet"
DRY_RUN=""
MAX_TURNS=25
MAX_BUDGET=3

# ─── Credential check ──────────────────────────────────────────────────────
# afk chat in non-TTY mode (piped stdout) hard-exits at src/cli/index.ts:224
# when no credential is found, because it can't prompt the auth wizard.
# The credential must be available via env var or keychain BEFORE this script
# runs. Three ways to satisfy:
#   1. export ANTHROPIC_API_KEY=sk-ant-...     (metered API key)
#   2. afk login                                (refreshes keychain OAuth)
#   3. Set ANTHROPIC_API_KEY in ~/.afk/config/afk.env
# ───────────────────────────────────────────────────────────────────────────
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  # Try to read OAuth token from keychain (macOS only)
  KEYCHAIN_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('claudeAiOauth',{}).get('accessToken',''); print(t)" 2>/dev/null || true)
  if [ -n "$KEYCHAIN_TOKEN" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$KEYCHAIN_TOKEN"
    echo "  [auth] Using Claude Code OAuth token from keychain"
  else
    echo "ERROR: No Anthropic credential found for non-TTY subprocess."
    echo ""
    echo "  afk chat exits immediately in piped mode without a credential."
    echo "  Fix: run one of these before this script:"
    echo ""
    echo "    export ANTHROPIC_API_KEY=sk-ant-...        # metered API key"
    echo "    afk login                                   # refresh keychain OAuth"
    echo "    afk config set env ANTHROPIC_API_KEY <key>  # persist in afk.env"
    echo ""
    exit 1
  fi
fi

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --model)    MODEL="$2"; shift 2;;
    --dry-run)  DRY_RUN=1; shift;;
    --max-turns) MAX_TURNS="$2"; shift 2;;
    --budget)   MAX_BUDGET="$2"; shift 2;;
    *)          echo "Unknown flag: $1"; exit 2;;
  esac
done

mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

# ─── The experiment prompt ──────────────────────────────────────────────────
# This prompt is designed to trigger multiple parallel subagent dispatches
# that read overlapping files in the agent-afk codebase.
# ─────────────────────────────────────────────────────────────────────────────
PROMPT_FILE="$RESULTS_DIR/prompt.md"
cat > "$PROMPT_FILE" <<'PROMPT_EOF'
Investigate how agent-afk handles rate limiting and retries across its two provider implementations (anthropic-direct and openai-compatible). Use the compose tool to dispatch three parallel investigation subagents:

1. **Provider A investigator**: Read src/agent/providers/anthropic-direct/ — find every retry loop, rate-limit handler, backoff strategy, and error recovery path. Report each mechanism with file:line citations.

2. **Provider B investigator**: Read src/agent/providers/openai-compatible/ — find every retry loop, rate-limit handler, backoff strategy, and error recovery path. Report each mechanism with file:line citations.

3. **Shared infrastructure investigator**: Read src/agent/providers/index.ts, src/agent/session.ts, src/agent/subagent.ts, and src/config/env.ts — find retry-related env vars, shared error classification, and any provider-agnostic retry/backoff infrastructure. Report with file:line citations.

After all three complete, synthesize a comparison table showing:
- Which retry mechanisms are provider-specific vs shared
- Whether the two providers handle 429s consistently
- Any gaps where one provider has retry coverage the other lacks

Write the comparison to a file at /tmp/workspace-ab-result.md.
PROMPT_EOF

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Shared Agent Workspace A/B Experiment                     ║"
echo "║  Timestamp: $TIMESTAMP                                     ║"
echo "║  Model: $MODEL  Max-turns: $MAX_TURNS  Budget: \$$MAX_BUDGET ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [ -n "$DRY_RUN" ]; then
  echo "[DRY RUN] Would run two arms with prompt:"
  cat "$PROMPT_FILE"
  echo ""
  echo "[DRY RUN] Arm A: AFK_WORKSPACE_DISABLED=1 node $AFK_BIN chat -m $MODEL --max-turns $MAX_TURNS ..."
  echo "[DRY RUN] Arm B: (workspace enabled)       node $AFK_BIN chat -m $MODEL --max-turns $MAX_TURNS ..."
  exit 0
fi

# ─── ARM A: Control (workspace disabled) ────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ARM A — CONTROL (AFK_WORKSPACE_DISABLED=1)"
echo "════════════════════════════════════════════════════════════════"
echo ""

ARM_A_START=$(date +%s)
AFK_WORKSPACE_DISABLED=1 \
  node "$AFK_BIN" chat \
    -m "$MODEL" \
    --max-turns "$MAX_TURNS" \
    --max-budget-usd "$MAX_BUDGET" \
    -f json \
    "$(cat "$PROMPT_FILE")" \
  > "$RESULTS_DIR/arm-a-output-$TIMESTAMP.json" 2>&1 || true
ARM_A_END=$(date +%s)
ARM_A_DURATION=$((ARM_A_END - ARM_A_START))

echo ""
echo "  Arm A completed in ${ARM_A_DURATION}s"

# Capture the session ID from the most recent witness trace
sleep 2  # let trace flush
ARM_A_SESSION=$(ls -t "$HOME/.afk/state/witness/" | head -1)
echo "  Arm A session: $ARM_A_SESSION"

# Measure dedup for arm A
echo ""
echo "  Measuring Arm A dedup..."
npx tsx "$MEASURE_SCRIPT" --session "$ARM_A_SESSION" --json > "$RESULTS_DIR/arm-a-dedup-$TIMESTAMP.json" 2>&1 || true
npx tsx "$MEASURE_SCRIPT" --session "$ARM_A_SESSION" 2>&1 | tee "$RESULTS_DIR/arm-a-dedup-$TIMESTAMP.txt" || true

# ─── ARM B: Treatment (workspace enabled) ───────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ARM B — TREATMENT (workspace enabled)"
echo "════════════════════════════════════════════════════════════════"
echo ""

ARM_B_START=$(date +%s)
env -u AFK_WORKSPACE_DISABLED node "$AFK_BIN" chat \
  -m "$MODEL" \
  --max-turns "$MAX_TURNS" \
  --max-budget-usd "$MAX_BUDGET" \
  -f json \
  "$(cat "$PROMPT_FILE")" \
> "$RESULTS_DIR/arm-b-output-$TIMESTAMP.json" 2>&1 || true
ARM_B_END=$(date +%s)
ARM_B_DURATION=$((ARM_B_END - ARM_B_START))

echo ""
echo "  Arm B completed in ${ARM_B_DURATION}s"

sleep 2  # let trace flush
ARM_B_SESSION=$(ls -t "$HOME/.afk/state/witness/" | head -1)
echo "  Arm B session: $ARM_B_SESSION"

# Measure dedup for arm B
echo ""
echo "  Measuring Arm B dedup..."
npx tsx "$MEASURE_SCRIPT" --session "$ARM_B_SESSION" --json > "$RESULTS_DIR/arm-b-dedup-$TIMESTAMP.json" 2>&1 || true
npx tsx "$MEASURE_SCRIPT" --session "$ARM_B_SESSION" 2>&1 | tee "$RESULTS_DIR/arm-b-dedup-$TIMESTAMP.txt" || true

# ─── Comparison ─────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  COMPARISON                                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Extract key metrics from JSON reports
ARM_A_RATIO=$(node -e "try { const r=require('$RESULTS_DIR/arm-a-dedup-$TIMESTAMP.json'); console.log((r.crossAgentDedupRatio*100).toFixed(1)+'%'); } catch(e) { console.log('N/A'); }")
ARM_B_RATIO=$(node -e "try { const r=require('$RESULTS_DIR/arm-b-dedup-$TIMESTAMP.json'); console.log((r.crossAgentDedupRatio*100).toFixed(1)+'%'); } catch(e) { console.log('N/A'); }")
ARM_A_CALLS=$(node -e "try { const r=require('$RESULTS_DIR/arm-a-dedup-$TIMESTAMP.json'); console.log(r.totalCalls); } catch(e) { console.log('N/A'); }")
ARM_B_CALLS=$(node -e "try { const r=require('$RESULTS_DIR/arm-b-dedup-$TIMESTAMP.json'); console.log(r.totalCalls); } catch(e) { console.log('N/A'); }")
ARM_A_DUPES=$(node -e "try { const r=require('$RESULTS_DIR/arm-a-dedup-$TIMESTAMP.json'); console.log(r.crossAgentDuplicates); } catch(e) { console.log('N/A'); }")
ARM_B_DUPES=$(node -e "try { const r=require('$RESULTS_DIR/arm-b-dedup-$TIMESTAMP.json'); console.log(r.crossAgentDuplicates); } catch(e) { console.log('N/A'); }")
ARM_A_AGENTS=$(node -e "try { const r=require('$RESULTS_DIR/arm-a-dedup-$TIMESTAMP.json'); console.log(r.distinctAgents); } catch(e) { console.log('N/A'); }")
ARM_B_AGENTS=$(node -e "try { const r=require('$RESULTS_DIR/arm-b-dedup-$TIMESTAMP.json'); console.log(r.distinctAgents); } catch(e) { console.log('N/A'); }")

REPORT="$RESULTS_DIR/comparison-$TIMESTAMP.md"
cat > "$REPORT" <<REPORT_EOF
# Workspace A/B Experiment — $TIMESTAMP

## Setup
- **Model**: $MODEL
- **Max turns**: $MAX_TURNS
- **Budget**: \$$MAX_BUDGET
- **Task**: Parallel 3-agent provider retry investigation (compose tool)
- **Repo**: agent-afk @ $(cd "$REPO_ROOT" && git rev-parse --short HEAD)

## Results

| Metric                    | Arm A (Control — No Workspace) | Arm B (Treatment — Workspace) |
|---------------------------|-------------------------------|-------------------------------|
| Wall-clock time           | ${ARM_A_DURATION}s            | ${ARM_B_DURATION}s            |
| Distinct agents           | $ARM_A_AGENTS                 | $ARM_B_AGENTS                 |
| Total read_file calls     | $ARM_A_CALLS                  | $ARM_B_CALLS                  |
| Cross-agent duplicates    | $ARM_A_DUPES                  | $ARM_B_DUPES                  |
| **Cross-agent dedup ratio** | **$ARM_A_RATIO**            | **$ARM_B_RATIO**              |

## Sessions
- Arm A: \`$ARM_A_SESSION\`
- Arm B: \`$ARM_B_SESSION\`

## Interpretation
A **lower** cross-agent dedup ratio in Arm B means the workspace successfully
reduced redundant file reads across sibling agents. The hypothesis is that
workspace-enabled agents share findings, so later agents skip files already
analyzed by earlier siblings.

## Raw data
- \`arm-a-dedup-$TIMESTAMP.json\`
- \`arm-b-dedup-$TIMESTAMP.json\`
- \`arm-a-output-$TIMESTAMP.json\`
- \`arm-b-output-$TIMESTAMP.json\`
REPORT_EOF

echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Metric                  │  Arm A (ctrl) │  Arm B (ws) │"
echo "  ├──────────────────────────┼───────────────┼─────────────┤"
echo "  │  Wall-clock time         │  ${ARM_A_DURATION}s           │  ${ARM_B_DURATION}s         │"
echo "  │  Distinct agents         │  $ARM_A_AGENTS              │  $ARM_B_AGENTS            │"
echo "  │  Total read_file calls   │  $ARM_A_CALLS              │  $ARM_B_CALLS            │"
echo "  │  Cross-agent duplicates  │  $ARM_A_DUPES              │  $ARM_B_DUPES            │"
echo "  │  Dedup ratio             │  $ARM_A_RATIO          │  $ARM_B_RATIO        │"
echo "  └──────────────────────────┴───────────────┴─────────────┘"
echo ""
echo "  Full report: $REPORT"
echo ""
echo "  Done."
