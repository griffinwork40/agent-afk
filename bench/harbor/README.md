# Harbor Benchmark Adapter for agent-afk

Run agent-afk against Harbor datasets (Terminal-Bench, SWE-bench Pro, GAIA) alongside built-in agents (oracle, claude-code) at a fixed model.

## Prerequisites

- Harbor 0.23.0 installed: `pip install harbor==0.23.0` or `uv tool install harbor==0.23.0`
- Docker Desktop running (arm64 Mac supported; Harbor Docker environment uses glibc images — nvm node install works)
- `ANTHROPIC_API_KEY` set in your environment (**⚠ export this first**)
- Python 3.11+ with the harbor package on `PYTHONPATH` (see test instructions)

> ⚠ The API key is forwarded into the container via `--ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY`.  
> Docker isolates the host filesystem from the container, but the key does enter the container environment.  
> Never commit keys or pass them in plaintext in CI logs.

## Import path

The AfkAgent is loaded by Harbor via its Python import path:

```
bench.harbor.afk_agent:AfkAgent
```

Run `harbor run` from the repo root with `PYTHONPATH=.` so Python can find the `bench/` package:

```bash
PYTHONPATH=. harbor run -a bench.harbor.afk_agent:AfkAgent ...
```

## Minimal arm description

The `variant=minimal` arm sets:
- `AFK_FRAMEWORK_PROMPT_FILE` → empty file, so `loadSystemPrompt()` returns `""` instead of the bundled `system-prompt.md`
- `AFK_MAX_NESTING_DEPTH=0` → disables the `agent`, `skill`, and `compose` dispatch tools entirely

Result: **no framework prompt, no delegation tools; builtin tools and any cwd AFK.md overlay remain.**  
Task directories are benchmark-controlled and typically contain no `afk.config.json`, so the overlay is usually absent too.

## Verified oracle baseline: Terminal-Bench

The oracle agent confirms the benchmark harness and Docker environment work. Verified 2026-09-30 on arm64 macOS with Docker Desktop 8 GB:

```bash
harbor run \
  -a oracle \
  -d terminal-bench \
  --n-tasks 1 \
  --env docker \
  -o bench/harbor/jobs \
  --job-name oracle-smoke
```

Result: `gpt2-codegolf` task, reward=1.0, runtime ≈55s.

## Smoke run: single Terminal-Bench task with AfkAgent

> ⚠ Export `ANTHROPIC_API_KEY` first — the agent stops at "No Anthropic credential found" without it.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # ⚠ required

PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d terminal-bench \
  --n-tasks 1 \
  -i "gpt2-codegolf" \
  --model anthropic/claude-haiku-4-5 \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -o bench/harbor/jobs \
  --job-name afk-smoke
```

Without the API key, `afk-stream.txt` will contain:
```
agent-afk: No Anthropic credential found. Run `afk login` to authenticate.
```
and Harbor raises `NonZeroAgentExitCodeError` — this is the expected behavior.

> **⚠ Default --max-turns pitfall**: `afk chat` defaults to `--max-turns 10` which is too low for most
> benchmark tasks. AfkAgent sets `max_turns=100` by default. Override with `--ak max_turns=200` if needed.

> **Cost estimate**: a single Terminal-Bench task with claude-haiku-4-5 costs roughly $0.01–$0.10.  
> claude-sonnet-4-5 is ~5–10× more expensive per task. **Always run a 10-20 task sample before a full run.**

## Paired comparison: afk-full vs afk-minimal vs oracle

Run 10 tasks with each arm at the same model seed for a paired comparison:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # ⚠ required
MODEL=anthropic/claude-haiku-4-5
N=10

# Oracle baseline (no API key needed)
harbor run \
  -a oracle \
  -d terminal-bench --n-tasks $N \
  --env docker \
  --job-name oracle-$(date +%Y%m%d) \
  -o bench/harbor/jobs

# afk full arm
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d terminal-bench --n-tasks $N \
  --model $MODEL \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --ak variant=full \
  --job-name afk-full-$(date +%Y%m%d) \
  -o bench/harbor/jobs

# afk minimal arm (ablation: no framework prompt, no subagent dispatch)
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d terminal-bench --n-tasks $N \
  --model $MODEL \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --ak variant=minimal \
  --job-name afk-minimal-$(date +%Y%m%d) \
  -o bench/harbor/jobs

# claude-code baseline
PYTHONPATH=. harbor run \
  -a claude-code \
  -d terminal-bench --n-tasks $N \
  --model $MODEL \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --job-name claude-code-$(date +%Y%m%d) \
  -o bench/harbor/jobs
```

Compare results with the included `compare.py`:

```bash
/Users/griffinlong/.local/share/uv/tools/harbor/bin/python bench/harbor/compare.py \
  bench/harbor/jobs/oracle-YYYYMMDD \
  bench/harbor/jobs/afk-full-YYYYMMDD \
  bench/harbor/jobs/afk-minimal-YYYYMMDD \
  bench/harbor/jobs/claude-code-YYYYMMDD
```

The script reads Harbor's per-trial `result.json` files (at `verifier_result.rewards.reward`) and emits a per-task table + McNemar p-value for the first two arms.

## GAIA dataset

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # ⚠ required
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d gaia --n-tasks 10 \
  --model anthropic/claude-haiku-4-5 \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -o bench/harbor/jobs
```

Dataset adapters: Harbor's built-in `gaia` adapter.  
HF leaderboard: https://huggingface.co/spaces/gaia-benchmark/leaderboard

## SWE-bench Pro

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # ⚠ required
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d swe-bench-pro --n-tasks 5 \
  --model anthropic/claude-sonnet-4-5 \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -o bench/harbor/jobs
```

**Note**: SWE-bench Verified leaderboard requires academic affiliation + arXiv paper since 2025-11-18 (source: swe-bench/experiments README). Community submissions to the Verified leaderboard are gated; check current requirements before submitting.

## Agent kwargs reference

Pass via `--ak key=value` (repeatable):

| Kwarg | Default | Description |
|-------|---------|-------------|
| `variant` | `full` | `full` = full AFK framework; `minimal` = empty prompt + no subagents (no framework prompt, no delegation tools; builtin tools + any cwd AFK.md remain) |
| `max_turns` | `100` | Max conversation turns (default `afk chat` is 10 — too low!) |
| `effort` | (none) | Effort level: `low\|medium\|high\|xhigh\|max` |
| `max_budget_usd` | (none) | Hard cost ceiling per trial, e.g. `"5.00"` |
| `afk_version` | (latest) | npm version pin, e.g. `"5.278.2"` |
| `context_window` | (unset) | Context-window override in tokens, e.g. `128000`. Writes `$AFK_HOME/config/afk.config.json` before `afk chat` runs. Requires **agent-afk ≥ 5.284.0** (the `contextWindow` slot binding, PR #2793). When unset, no config file is written and afk uses its built-in table (64 000 for `qwen-3.8-27b`). |

> **`afk_version` and `context_window` interaction**: if you pin `afk_version` to a release
> older than 5.284.0, the written config file is ignored (that version doesn't read
> `contextWindow` from the slot binding). Either omit `afk_version` (gets latest) or pin
> to ≥ 5.284.0 when using `context_window`.

## Cerebras (paid tier: 128 k context window)

Cerebras's `qwen-3.8-27b` provides 64 k context on the free tier and 128 k on paid.
The adapter's built-in limit table defaults to the conservative 64 k; pass
`--ak context_window=128000` to raise it.

The adapter writes a `"local"` slot binding to `$AFK_HOME/config/afk.config.json`
before each trial run. `contextWindowOverrideFor('qwen-3.8-27b')` in
`src/agent/session/model-slots.ts:499` then returns 128 000, and
`contextLimitFor` honours it for compaction / budget math.

> **zsh verified smoke command** (reward 1.0 on `log-summary-date-ranges`):

```zsh
export CEREBRAS_API_KEY="$(sed -n 's/^AFK_MODEL_LOCAL_API_KEY=//p' ~/.afk/config/afk.env | tr -d "\"'")"
M=cerebras/qwen-3.8-27b
AFKENV=(
  --ae AFK_PROVIDER=openai-compatible
  --ae AFK_OPENAI_BASE_URL=https://api.cerebras.ai/v1
  --ae OPENAI_API_KEY=$CEREBRAS_API_KEY
)
PYTHONPATH=. harbor run -a bench.harbor.afk_agent:AfkAgent --ak variant=full \
  -d terminal-bench --n-tasks 1 -i log-summary-date-ranges --model $M --env docker --n-concurrent 1 \
  "${AFKENV[@]}" -o bench/harbor/jobs --job-name qwen-smoke-afk \
  --ak context_window=128000
```

Notes:
- Harbor's agent kwargs flag is `--ak` (not `-ak`).
- Use a zsh array for `AFKENV` — do not unquote the variable in bash, which would split on spaces.
- `AFK_PROVIDER=openai-compatible` routes afk to the OpenAI-compatible provider stack;
  `AFK_OPENAI_BASE_URL` points it at Cerebras; `OPENAI_API_KEY` carries the credential.
- Requires **agent-afk ≥ 5.284.0**; the adapter installs latest by default (omit `--ak afk_version`
  or pin to ≥ 5.284.0).

## Running tests

```bash
# Install pytest into the harbor Python interpreter (one-time)
uv pip install --python /Users/griffinlong/.local/share/uv/tools/harbor/bin/python pytest

# Run from repo root (PYTHONPATH not needed — conftest.py handles sys.path)
/Users/griffinlong/.local/share/uv/tools/harbor/bin/python \
  -m pytest bench/harbor/ -v
```

Tests do not require Docker or an API key — they exercise pure Python logic only.

## Nightly eval

**Nightly Harbor Eval** (`.github/workflows/nightly-harbor-eval.yml`) runs at
03:23 UTC, or manually via Actions → Nightly Harbor Eval → Run workflow on
`main`. Forks and non-main dispatches do no work; PR events never trigger it.

**Enable:** Settings → Secrets and variables → Actions → New repository secret →
name **`CLAUDE_CODE_OAUTH_TOKEN`**, paste a valid Claude Code OAuth token, save.
Alternatively add **`ANTHROPIC_API_KEY`**. Missing both fails the credential job
visibly; no benchmark is claimed. Tokens are only forwarded to the eval job and
trial containers, never to the history publisher. Keep credentials current;
auth/setup/verifier failures fail the run and are excluded from comparisons.

The sole protocol declaration is [`nightly.json`](nightly.json): ten literal
Terminal-Bench 2.0 task names, immutable task-repository commit, dated Haiku 4.5
model, full framework, concurrency two, 100 turns and $2 budget per task. Harbor
0.23 selects tasks using `DatasetConfig.task_names` (CLI equivalent: repeat
`--include-task-name NAME` / `-i NAME`); this is not a random `--n-tasks` sample.
The workflow builds and packs the **checked-out commit**, then uploads that
local tarball into each container using the adapter's `afk_package` kwarg.
There is no npm-latest fallback for the nightly.

Agent execution gets 900 seconds, separately from 600-second installation and
pinned 600-second environment build limits; verification gets 180 seconds.
Expected runtime is roughly 45–100 minutes, with a 180-minute job ceiling for
infrastructure delays. This is a time-limited smoke metric, not the official
Terminal-Bench leaderboard. Haiku reduces recurring cost; estimate $0.50–$5 per
night, with a configured $20 aggregate task budget (not a billing guarantee:
in-flight requests, delegation, and provider accounting can overshoot). OAuth
usage consumes subscription allowance instead of necessarily billing API dollars.

Each real run appends a sanitized JSONL record to
[`harbor-results:history.jsonl`](https://github.com/griffinwork40/agent-afk/blob/harbor-results/history.jsonl)
(the branch is created by the first run). No workflow pushes to `main`. Records
include UTC date, source SHA, afk version, model/protocol, per-task reward and
error class, and all-task mean. Missing trials/rewards count as zero and mark
the run invalid, never disappear from the denominator. Timeout trials retain
the verifier reward, including a pass achieved before the agent was stopped.
Raw Harbor logs/configs are **not uploaded** because they may contain secrets.
When the agent command exits non-zero, the task also gets an `exit_reason`
(`bench/harbor/exit_reason.py`): a category from a fixed list (for example
`no_credential`, `auth_rejected`, `usage_limit`, `unknown_option`), the exit
code, the phase (`setup` or `run`), and for `unknown_option` the flag name if
it is one the adapter passes. It never contains agent output. It is additive:
validity and comparability are unchanged.
The sanitized record artifact is retained 30 days; branch history is durable.
Job summaries contain the per-task table and regression decision.

**Signal:** one tracking issue labelled `nightly-eval-regression` is created or
reopened/commented only on a meaningful drop. Require ten valid **scheduled**
UTC dates at the identical protocol fingerprint; compare the latest three-night
per-task means against the preceding seven. Alert only for an overall drop of
at least **20 percentage points AND one-sided paired sign-flip p ≤ 0.01**.
Manual runs are recorded but cannot alter the baseline or alarm; a first run
cannot alarm. A model/task/timeout/protocol change starts a new warmup. Errors
outside `AgentTimeoutError` are infrastructure-invalid and visibly fail rather
than producing a misleading behavioural alarm. At n=10 and p≈0.6, single-night
standard error is ≈15.5pp; windows avoid reacting to ordinary single-night noise.
The nominal ≤1% per-comparison false-positive interpretation requires independent,
symmetric task deltas: correlated tasks, temporal drift, overlapping daily windows
and repeated testing mean **no guaranteed annual false-alarm rate**. Sparse
regressions affecting only a few tasks may not trigger; inspect the summary too.

The local `s10-afk-full` evidence is gitignored, **not committed**. Its five
execution timeouts were 900s (three tasks), 1200s (HTML filter), and 3600s
(corewars), not installation time: for example, `gpt2-codegolf` setup finished
at 01:42:01 and execution ran until 01:57:01. Stream logs show continuing agent
work, not setup. They do not prove whether model latency, tool time, or looping
was the dominant cause. The nightly deliberately bounds agent time, separates
installation, avoids the one-hour corewars task and expensive ML/data tasks,
and does not assert that longer timeouts would fix the agent.

Offline checks (no model calls):

```bash
python -m pytest bench/harbor/ -q
# With a built pnpm-pack tarball and the pinned task checkout:
PYTHONPATH=. python -m bench.harbor.nightly_run --prepare-only \
  --package /path/to/agent-afk.tgz --tasks /path/to/terminal-bench --output /tmp/eval
```

The first default-branch run must confirm hosted Docker/image availability,
credential/model acceptance, observed runtime/spend, and the GITHUB_TOKEN's
permission to create/update `harbor-results` and the tracking issue.

## Job output layout

Harbor writes results to `bench/harbor/jobs/<job-name>/` (gitignored). Each trial:
- `<trial_name>/result.json` — `verifier_result.rewards.reward` (0.0–1.0)
- `<trial_name>/agent/afk-stream.txt` — raw stream-json NDJSON from `afk chat`
- `<trial_name>/exception.txt` — present on error (e.g. NonZeroAgentExitCodeError)

Quick reward check:
```bash
harbor view bench/harbor/jobs   # web UI at http://localhost:8080
```
