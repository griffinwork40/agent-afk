# afk whatif — Behavioural Impact Predictor

`afk whatif` and `/whatif` predict how a proposed change to your AFK
environment (prompts, memory, model, skills, plugins, env vars) will affect the
agent's behaviour — **before you commit to it**.

---

## What it does

You describe a proposed change in plain English or with explicit flags. The
engine:

1. **Analyses the structural diff** (free, no model calls): shows the exact
   system-prompt diff, which tools were added or removed, token-count delta, and
   per-turn cost delta.

2. **Predicts up to 8 behaviour changes** (~1 cent): an analyst model studies
   the diff and produces a labelled list of predicted shifts (added / removed /
   strengthened / weakened), each with a confidence rating and a yes/no test
   question. **Always labelled a guess.**

3. **Verifies empirically (optional, `--verify`)**: real or synthetic episodes
   run in isolated sandboxes for both the baseline and candidate environments.
   Rates are measured (P(yes) per prediction), each prediction is marked
   Confirmed / Refuted / Unclear, and unpredicted differences are proposed.

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
| 0 Structural | System-prompt diff, tool list diff, token/cost delta | Free |
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

### Key env vars

| Var | Set by | Meaning |
|-----|--------|---------|
| `AFK_WHATIF_EPISODE` | engine | `1` = this process is a sandboxed episode |
| `AFK_WHATIF_TOOL_LOG` | engine | Absolute path for the episode tool-call log |
| `AFK_WHATIF_ALLOW_MCP` | user (opt-in) | `1` = allow MCP in episodes |

**Episode gate rules**: when `AFK_WHATIF_EPISODE=1`, the PreToolUse hook
classifies every tool call as `'executed'` (read-only) or `'recorded'`
(side-effecting). The first `'recorded'` verdict latches the gate; all
subsequent calls are also blocked. The gate applies tree-wide (no subagent
exemption). The gate is implemented in `src/agent/whatif-episode-gate.ts`.

### Files

```
src/whatif/                     Engine core
src/cli/commands/whatif.ts      CLI surface
src/cli/slash/commands/whatif.ts  REPL surface
docs/whatif.md                  This file
```

### Limits

Every report includes standard caveats:
- Predictions are guesses; `--verify` provides evidence.
- Episodes stop at the first side effect; downstream consequences are not shown.
- Preamble stripping from real turns is heuristic.
- Redaction of secrets from real turns is regex best-effort; use `--judge claude`
  to keep data within Anthropic.
- Statistical rates have uncertainty (Wilson 95% CI shown in the report).
