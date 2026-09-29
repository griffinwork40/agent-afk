# afk whatif — Behavioural Impact Predictor

`afk whatif` and `/whatif` predict how a proposed change to your AFK
environment (prompts, memory, model, skills, plugins, env vars) will affect the
agent's behaviour — **before you commit to it**.

---

## What it does

You describe a proposed change in plain English or with explicit flags. The
engine:

1. **Analyses the structural diff** (free, no model calls): captures a one-turn
   snapshot for each environment, then shows the diff between the system prompt
   that each environment sent to the model, which tools were added or removed,
   token-count delta, and per-turn cost delta.

2. **Predicts up to `--max-predictions` behaviour changes** (~1 cent; default 3, or 8 with `--probes 2` or fewer), each with
   `--probes` diverse test requests (default 6, near-duplicates dropped): an analyst model studies
   the diff and produces a labelled list of predicted shifts (added / removed /
   strengthened / weakened), each with a confidence rating and a yes/no test
   question. **Always labelled a guess.**

3. **Verifies empirically (optional, `--verify`)**: real or synthetic episodes
   run in isolated sandboxes for both the baseline and candidate environments.
   Rates are measured (P(yes) per prediction), each prediction is marked
   Confirmed / Refuted / Unclear, and unpredicted differences are proposed.
   Each prediction is scored only on its own probes (see
   [Which episodes score a prediction](#which-episodes-score-a-prediction)).
   Episodes stop at the agent's first side-effecting request, and the judges
   grade that request as intent: `[tool requested: agent (not executed)]`
   counts as the agent spawning a subagent. So a prediction about what the
   agent *chooses* is measurable even though the action never runs.
   A prediction whose behavior needs an intercepted action to *complete*
   (the tests pass, the written file is correct, the subagent finds the bug)
   cannot be measured. The predict step tags each prediction up front as
   `decision` or `downstream`, before any episode runs. Every `downstream`
   prediction is marked **Unobservable** 🔭 with a one-line reason, whatever
   its measured rates. Its rates are still shown for transparency, but it
   never counts as Confirmed or Refuted: it is left out of prediction accuracy,
   the calibration ledger, and the headline effect. The verdict never changes
   based on what happened in the episodes (for example, which tools were
   intercepted).

4. **Records calibration**: every prediction + verified outcome is appended to
   `~/.afk/state/whatif/ledger.jsonl` to improve future predictions.

---

## Quick start

```bash
# Plain English — compiled, confirmed, then run
afk whatif "turn off auto-routing"

# Explicit flags (bypass compilation)
afk whatif --append "Always ask a clarifying question before using tools."
afk whatif --model claude-haiku-4-5

# With verification
afk whatif --append "Never use bash" --verify

# From a prepared spec file
afk whatif --spec my-change.json

# REPL
/whatif "disable the diagnose skill" --quick
/whatif --memory-add "prefers pnpm test:file" --verify --yes
```

---

## The four levels

| Level | What happens | Cost |
|-------|-------------|------|
| 0 Structural | Diff of the system prompts captured from each env's one-turn snapshot request, tool list diff, token/cost delta | Free |
| 1 Predict | Analyst model produces labelled behaviour predictions | ~$0.01 |
| 2 Verify | Episodes in sandboxes; rates measured; predictions tested | ~$0.50–$5 |
| 3 Calibrate | Predictions + outcomes written to calibration ledger | Free |

Use `--quick` for single-turn episodes when budget or time is tight.

---

## CLI examples

```bash
# Predict only (levels 0 + 1)
afk whatif "add a rule to always ask before committing"

# Multiple explicit changes
afk whatif \
  --append "Never use bash without asking first." \
  --memory-add "prefers TypeScript" \
  --model claude-haiku-4-5

# Verify with budget cap
afk whatif --append "Respond in French" --verify --max-usd 2

# Skip TTY confirmation (CI / scripts)
afk whatif "add always-ask rule" --yes --json | jq .costUsd

# Custom judge (keeps data within Anthropic)
afk whatif --append "Prefer concise answers" --verify --judge claude
```

## REPL examples

```
/whatif "disable the code-review skill"
/whatif --model claude-haiku-4-5 --verify --yes
/whatif --spec ./my-change.json --quick
/whatif --memory-add "prefers jest over vitest" --memory-category preference --yes
```

Confirmation in the REPL: when you provide plain-English text without `--yes`,
the engine prints the compiled spec and asks you to re-run with `--yes`. There
is no TTY readline prompt in the REPL.

---

## All flags

### Change flags (accumulate in order)

| Flag | Description |
|------|-------------|
| `--append <text>` | Append text to your AFK.md (user scope) |
| `--append-project <text>` | Append text to project AFK.md |
| `--file <path>=<localfile>` | Set a file (`home:<rel>` or `project:<rel>`) |
| `--hot <localfile>` | Replace HOT.md with a local file |
| `--memory-add <text>` | Add a memory fact |
| `--memory-category <cat>` | Category for next `--memory-add` (`preference`\|`convention`\|`decision`\|`learning`; default: `preference`) |
| `--memory-remove <id>` | Remove a memory fact by numeric id |
| `--disable-skill <name>` | Disable a skill by name |
| `--disable-plugin <name>` | Disable a plugin by name |
| `--model <id>` | Test a candidate model |
| `--effort <level>` | Test a candidate effort level |
| `--env KEY=VALUE` | Set an env var in the candidate sandbox |
| `--spec <file.json>` | Load a full ChangeSpec from a JSON file |

### Run options

| Flag | Default | Description |
|------|---------|-------------|
| `--agent-model <id>` | current model | Model the agent under test uses |
| `--analyst-model <id>` | `sonnet` | Model for compile/predict/judge |
| `--verify` | off | Run episodes and verify predictions |
| `--quick` | off | Single-turn episodes (sets `--max-turns 1`) |
| `--probes <n>` | 6 | Synthetic probe episodes per prediction (1–12). More probes give each prediction more statistical power. Near-duplicate probes are dropped automatically. |
| `--max-predictions <n>` | 3 (when `--probes > 2`), 8 otherwise | Maximum predictions to retain. Concentrating on fewer predictions with more probes improves verdict reliability. |
| `--turns <n>` | 12 | Real turns to replay |
| `--samples <n>` | 3 | Samples per episode per environment |
| `--max-usd <n>` | 5 | Budget cap in USD |
| `--judge auto\|jev\|claude` | auto | Judge for grading episodes |
| `--concurrency <n>` | 4 | Parallel episodes |
| `--max-turns <n>` | 3 | Max turns per episode |
| `--timeout <sec>` | 180 | Episode timeout |
| `--keep-sandboxes` | off | Keep sandbox dirs after run |
| `--yes` | off | Skip confirmation of compiled spec |
| `--json` | off | Print JSON to stdout |

---

## Reading the report

The terminal output shows:

- **Headline**: one sentence summarising the most notable prediction or result.
- **Structural diff**: system-prompt diff lines, tools added/removed, token delta.
- **Predictions**: each prediction with direction, confidence, and (if verified)
  rate comparison (baseline vs candidate %) and verdict.
- **Discovered differences**: unpredicted shifts found by the empirical pass.
- **Caveats**: fixed reminders about what the engine can and cannot see.

The full Markdown report is written to `~/.afk/state/whatif/<run-id>/report.md`.
When one or more episodes failed and the failures were arm-imbalanced, the
report emits a `[!WARNING]` block immediately after the Predictions table.  A
**Failed Episodes** section (between the warning and Unexpected Differences)
lists each failure with its arm, error class, duration, and error message.
`results.json` carries `verify.failedEpisodeRecords` (structured) and
`verify.armImbalance` (when the imbalance threshold was exceeded).

### Run-directory artifacts

Every `--verify` run writes four files under `~/.afk/state/whatif/<run-id>/`:

| File | Contents |
|------|----------|
| `report.md` | Human-readable Markdown summary |
| `results.json` | Full `WhatifReport` as JSON (predictions, verdicts, rates, scope) |
| `traces.jsonl` | One `EpisodeTrace` per line: episode id, env, sample, text, tools, cost |
| `grades.jsonl` | Per-output judge grades — see below (#2477) |

Predict-only runs (`--no-verify`) omit `traces.jsonl` and `grades.jsonl`.

#### grades.jsonl

`grades.jsonl` records the raw P(yes) score the primary judge assigned to each
(episode output × prediction) pair. Each line is a `GradeEntry`:

```jsonc
{
  "episodeId":    "s1",          // matches traces.jsonl episodeId
  "env":          "baseline",    // "baseline" | "candidate"
  "sample":       0,             // sample index (0-based), matches traces.jsonl
  "predictionId": "p1",          // matches verify.predictions[].prediction.id in results.json
  "pYes":         0.97           // continuous P(yes) from the primary judge (0–1)
}
```

The four pairing keys — `episodeId`, `env`, `sample`, `predictionId` — are
sufficient to:

- Join a grade back to its episode output in `traces.jsonl` via
  `episodeId + ":" + env + ":" + sample`
- Join to the prediction verdict in `results.json` via `predictionId`
- Pair the same probe across arms by grouping on `(episodeId, sample, predictionId)`
  and comparing `env === "baseline"` vs `env === "candidate"` rows

This pairing enables per-probe ICC, paired SE, and exact sign-flip tests
(#2477 step 3) from saved artifacts without any code changes. Episodes where the
agent run failed (`traces.jsonl[].error`) or where the judge failed are omitted.

### Which episodes score a prediction

Every episode output is graded once, on every question, in a single judge call.
What differs is which of those grades feed each prediction's result:

- **Before / After / CI / Result** use only the prediction's own synthetic
  probes (episodes whose `targets` is that prediction's id). A replayed turn
  like "why does fast compact fail?" gives the agent no chance to show "honors
  an explicit subagent request", so pooling it in would only pull the delta
  toward zero. Before #2403 every episode was pooled, which diluted a real
  effect about 10x (2 probes at 0% → 100% plus 18 unrelated episodes at 0% read
  as a 10-point shift).
- **Other episodes** is the same question graded on every other episode
  (replayed real turns, suite prompts, other predictions' probes). It is
  context only, for spotting a behavior that leaks outside its probes, and
  never affects the result. Because of that, every prediction's probes are
  queued **before** the replayed turns (#2477): when `--max-usd` stops the run
  early, the dropped tail is background context, not the probes a verdict
  needs. The preflight prints the estimated spend split into probe episodes
  and replay/suite episodes; if it exceeds `--max-usd`, raise the cap to the
  printed amount or cut `--probes`, `--max-predictions`, `--samples`, or
  `--turns`.
- **Scored on** shows how many probes contributed and `n` (graded outputs per
  arm, baseline/candidate). A prediction with no graded probe (all failed,
  budget stop, judge failure) shows `no graded probes` and is always Unclear.
- **Episodes behind each result** lists the contributing episode ids.

`results.json` carries the same data per prediction under
`verify.predictions[].scope`: `episodes.baseline` / `episodes.candidate` (ids
with a graded output), `targetedEpisodes` (probes planned), and `background`
(the other-episodes rate comparison, absent when an arm had none). The
Measured Behaviors table and Unexpected Differences still use every episode,
since those are universal.

Observability fields in `results.json` (#2409):

- `predictions[].observable` (and `verify.predictions[].prediction.observable`):
  `"decision"` or `"downstream"`, set by the predict step. A missing or
  unrecognised value, as in results written before #2409, means `"decision"`.
- `predictions[].observabilityReason`: optional short reason on a
  `"downstream"` prediction.
- `verify.predictions[].verdict` is one of `"confirmed"`, `"refuted"`,
  `"unclear"` or `"unobservable"`. `"unobservable"` is set exactly when the
  prediction is `"downstream"`. Filter on all four values; code that only
  expects the first three will silently drop these rows.
- `verify.predictions[].unobservableReason`: present only on
  `"unobservable"` rows, e.g. `downstream of the episode boundary: the tests
  must run to completion`.
- `verify.predictionAccuracy` is confirmed / (confirmed + refuted): both
  `"unclear"` and `"unobservable"` are excluded.

### Per-probe sign-flip analysis (`probeSignFlip`) (#2477 step 3)

A secondary analysis, additive to the Newcombe verdict. Present on non-`unobservable`
predictions that have at least one targeted episode. Never changes `verdict`, `rates`,
or any other existing field.

```json
"probeSignFlip": {
  "nPaired": 10,          // probes with data in both arms
  "nUnpaired": 2,         // probes present in only one arm (dropped, biases toward no change)
  "nNonzero": 6,          // probes with |d_i| > 1e-9 (enter the test)
  "meanDelta": 0.082,     // mean of all paired per-probe differences (cand − base)
  "probeDiffs": [0.48, 0.0, 0.025, ...],  // per-probe d_i, in episode order
  "p": 0.2812,            // two-sided sign-flip p-value (null when nPaired=0)
  "minAchievableP": 0.03125,  // 2/2^nNonzero; null when nNonzero=0
  "underpoweredForSig": false, // true when minAchievableP > 0.05
  "method": "exact"       // "exact" (k≤16) or "montecarlo" (k>16, 100k draws)
}
```

**Pairing rule:** episodes present in both arms form paired probes. Episodes
present in only one arm (usually because all candidate runs timed out or failed)
are counted as `nUnpaired` and excluded. Excluding them biases toward no change,
so the `nUnpaired` count cross-references the arm-imbalance flag (#2494).

**Zero tolerance:** differences with |d_i| ≤ 1e-9 are excluded from the test.
They contribute to `meanDelta` and `probeDiffs` but not to `nNonzero` or `p`.

**Min achievable p:** with k nonzero probes, the two-sided p cannot go below
2/2^k. At k ≤ 4, min_p ≥ 0.125 and the test cannot reach conventional
significance regardless of effect size. At k = 6 (the pilot), min_p = 0.03125.

---

## Safety model

**Sandboxes**: each environment (baseline and candidate) runs in a private copy
of your `~/.afk` directory. Config files are copied (never symlinked) so writes
cannot leak back to your real home. Large read-only trees are symlinked for
speed.

**Episode mode gate**: inside a sandbox, read-only tools execute normally. The
first side-effecting action (writes, mutating bash, network POST, messaging, git
push, delegation) is **recorded** as the decision and **not executed**. No real
writes happen during a whatif run.

**What never happens during a whatif run**:
- Changes to your real `~/.afk` directory
- Real tool side effects (writes, git, network mutations)
- Plugin hooks with side effects (e.g. Telegram on SessionEnd) — disabled in
  episode mode
- Nested delegation — disabled in episode mode
- MCP calls — disabled unless the change concerns MCP (`AFK_WHATIF_ALLOW_MCP=1`)

**Credentials**: never copied into sandboxes. Episodes inherit the parent
process env so the API key is available to the agent subprocess.

---

## Cost

- Levels 0 + 1: typically < $0.02 (one analyst model call).
- Level 2 (`--verify`): depends on episode count. With defaults (3 samples × 12
  turns × 2 envs = 72 episodes, concurrency 4): ~$0.50–$3 for typical prompts.
  The preflight estimate is shown before running; `--max-usd` (default $5) aborts
  if exceeded.
- Use `--quick` (single-turn) to keep verification under $0.20.

---

## Judges: Jev and Claude

**Default (`--judge auto`)**: uses Jev (an external TypeSafe judge) when
`jev` is configured in `~/.afk/config/mcp.json`, otherwise falls back to Claude.

**Jev** (`--judge jev`): cross-family judge (removes self-preference bias),
calibrated probabilities, batches all questions per output. **Note**: Jev sends
redacted episode outputs to TypeSafe's servers. The report states the judge
used.

**Claude** (`--judge claude`): keeps all data within Anthropic. Use when
data privacy is a concern or when Jev is unavailable.

~10% of outputs are cross-graded by Claude regardless; the agreement rate
discounts confidence when the two judges disagree.

---

## Technical reference

### Architecture

```
afk whatif / /whatif
       │
       ├── src/whatif/args.ts          parseWhatifArgs / tokenizeSlashArgs
       ├── src/whatif/surface.ts       resolveSpec / buildWhatifDeps
       ├── src/whatif/compile.ts       plain-English → ChangeSpec
       │
       ├── src/whatif/run.ts           runWhatif orchestrator
       ├── src/whatif/sandbox.ts       environment materialiser
       ├── src/whatif/operators/       ChangeOperator implementations
       ├── src/whatif/runner/          AgentRunner (afk-runner subprocess)
       │
       ├── src/whatif/predict.ts       level 1 LLM predictions
       ├── src/whatif/episodes.ts      episode source selection
       ├── src/whatif/observe.ts       deterministic feature extraction
       ├── src/whatif/judge/           Jev + Claude judges
       ├── src/whatif/stats.ts         rate comparison + Wilson CI
       ├── src/whatif/discover.ts      unpredicted difference discovery
       ├── src/whatif/report.ts        terminal + Markdown rendering
       └── src/whatif/ledger.ts        calibration ledger
```

### Seams

**ChangeOperator** (`src/whatif/types.ts`): one implementation per change kind
(append, file, hot, memory-add, memory-remove, disable-skill, disable-plugin,
model, effort, env). New change kinds are added by implementing the interface
and registering in `src/whatif/operators/index.ts`.

**AgentRunner** (`src/whatif/types.ts`): the afk-runner spawns real `afk chat`
subprocesses. A generic OpenAI-messages runner (model + endpoint + system prompt
+ tools file) is planned for later.

### Testing framework prompt changes

Use `AFK_FRAMEWORK_PROMPT_FILE` with `--env` to A/B test a modified
`system-prompt.md` without touching the checked-in file:

```bash
# Create your modified prompt
cp system-prompt.md /tmp/whatif-narration/system-prompt.narrate.md
# Edit /tmp/whatif-narration/system-prompt.narrate.md as needed

# Run whatif — level 0+1 only (no episodes, near-zero cost)
afk whatif --env AFK_FRAMEWORK_PROMPT_FILE=/tmp/whatif-narration/system-prompt.narrate.md --yes

# Run with full verification
afk whatif --env AFK_FRAMEWORK_PROMPT_FILE=/tmp/whatif-narration/system-prompt.narrate.md --verify --yes
```

The structural snapshot in the report (`level 0`) shows the system-prompt diff
between the system prompt captured from the first API request of the baseline
snapshot run versus the candidate snapshot run. Level 1 predictions are
derived from that diff; Level 2 episodes run the agent with the modified prompt
in the candidate sandbox.

**Error behaviour**: if `AFK_FRAMEWORK_PROMPT_FILE` is a relative path or
points to an unreadable file, `loadSystemPrompt()` throws and the episode
fails loudly. It never falls back to the bundled prompt, since that would
silently turn the A/B run into an A/A run.

**Episode text**: episodes run `afk chat --format stream-json`, so the text
the judge grades is every assistant text segment in order, with a
`[tool: <name>]` marker at each tool call. Narration written between tool
calls is therefore visible to the judge, not just the final reply.

### Key env vars

| Var | Set by | Meaning |
|-----|--------|---------|
| `AFK_WHATIF_EPISODE` | engine | `1` = this process is a sandboxed episode |
| `AFK_WHATIF_TOOL_LOG` | engine | Absolute path for the episode tool-call log |
| `AFK_WHATIF_ALLOW_MCP` | user (opt-in) | `1` = allow MCP in episodes |
| `AFK_WHATIF_KEEP_CONTEXT_HOOKS` | user (opt-in) / engine (auto) | `1` = keep `SessionStart` and `UserPromptSubmit` hooks in episodes |
| `AFK_FRAMEWORK_PROMPT_FILE` | user (opt-in) | Replacement for bundled `system-prompt.md` |

**Episode gate rules**: when `AFK_WHATIF_EPISODE=1`, the PreToolUse hook
classifies every tool call as `'executed'` (read-only) or `'recorded'`
(side-effecting). The first `'recorded'` verdict latches the gate; all
subsequent calls are also blocked. The gate applies tree-wide (no subagent
exemption). The gate is implemented in `src/agent/whatif-episode-gate.ts`.

**Hook isolation**: inside an episode, `SessionStart` and `UserPromptSubmit`
config and plugin hooks are disabled by default. These are the only events
whose `injectContext` output reaches the first user message — a plugin hook
whose output depends on cwd and accumulated state would otherwise inject
arm-specific text and confound every delta measurement. Tool-gating hooks
(`PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, etc.) keep registering
normally because they cannot affect the first user message and their presence
makes the episode more realistic.

Set `AFK_WHATIF_KEEP_CONTEXT_HOOKS=1` to restore the pre-isolation behaviour.
The harness sets this flag **automatically** when the change spec itself
targets hooks or plugins (a `disable-plugin` change, or a `file` change
targeting `home:config/afk.config.json` or a `hooks.json` manifest) — so
both arms can observe the hook behaviour under test.

### Files

```
src/whatif/                     Engine core
src/cli/commands/whatif.ts      CLI surface
src/cli/slash/commands/whatif.ts  REPL surface
docs/whatif.md                  This file
```

### Failed episodes and arm-imbalance warning (#2411)

When `--verify` is used and one or more episodes fail (timeout or subprocess
error), the report and `results.json` now surface this explicitly:

- **`report.md` — Failed Episodes table**: every failed episode is listed with
  its arm (`baseline` or `candidate`), sample index, error class (`timeout` or
  `error`), wall-clock duration, and the first line of the error message.
  When the episode targeted a specific prediction, the prediction id (`p1`, …)
  is shown beside the episode id.

- **`results.json` — `verify.failedEpisodeRecords`**: a structured array with
  the same fields. Always present (empty array when no failures).

- **Arm-imbalance warning**: when failures are significantly concentrated in one
  arm, the report emits a prominent `[!WARNING]` block (Markdown) and a yellow
  banner (terminal). `results.json` includes `verify.armImbalance` with
  `baselineFailRate`, `candidateFailRate`, `rateDiff`, `allInOneArm`, and
  `concentrationArm`.

  **Threshold**: the warning fires when EITHER of these holds:
  - The absolute failure-rate difference between arms exceeds **20 percentage
    points** (20 pp). This is conservative enough not to flag a single stray
    failure in a small run (1/6 vs 0/6 = 17 pp) while reliably catching the
    pilot scenario (6/16 vs 0/26 = 37.5 pp).
  - All failures landed in a single arm AND the total failure count is at least
    2. This catches extreme concentration even when the pool is small.

  The warning message suggests raising `--timeout` as the most common remedy,
  since timeouts caused by the behaviour under test (e.g. the agent exploring
  more thoroughly after a clarifying-question change) are the primary cause of
  biased imbalance.

  **Counting timeouts as outcomes** (recording a timeout as an observable
  "did not finish within the turn") is deliberately deferred — see GitHub
  issues #2411 and #2415 for the full discussion.

### Limits

Every report includes standard caveats:
- Predictions are guesses; `--verify` provides evidence.
- Episodes stop at the first side effect; downstream consequences are not shown.
- Preamble stripping from real turns is heuristic.
- Redaction of secrets from real turns is regex best-effort; use `--judge claude`
  to keep data within Anthropic.
- Statistical rates have uncertainty (Wilson 95% CI shown in the report).
- Failed episodes are excluded from every rate; the Limits section names the count.
  When failures are arm-imbalanced, a warning flags the potential verdict bias.
