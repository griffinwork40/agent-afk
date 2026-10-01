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
> benchmark tasks. AfkAgent sets `max_turns=100` by default. Override with `-ak max_turns=200` if needed.

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
  -ak variant=full \
  --job-name afk-full-$(date +%Y%m%d) \
  -o bench/harbor/jobs

# afk minimal arm (ablation: no framework prompt, no subagent dispatch)
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d terminal-bench --n-tasks $N \
  --model $MODEL \
  --env docker \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -ak variant=minimal \
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

Pass via `-ak key=value` (repeatable):

| Kwarg | Default | Description |
|-------|---------|-------------|
| `variant` | `full` | `full` = full AFK framework; `minimal` = empty prompt + no subagents (no framework prompt, no delegation tools; builtin tools + any cwd AFK.md remain) |
| `max_turns` | `100` | Max conversation turns (default `afk chat` is 10 — too low!) |
| `effort` | (none) | Effort level: `low\|medium\|high\|xhigh\|max` |
| `max_budget_usd` | (none) | Hard cost ceiling per trial, e.g. `"5.00"` |
| `afk_version` | (latest) | npm version pin, e.g. `"5.278.2"` |

## Running tests

```bash
# Install pytest into the harbor Python interpreter (one-time)
uv pip install --python /Users/griffinlong/.local/share/uv/tools/harbor/bin/python pytest

# Run from repo root (PYTHONPATH not needed — conftest.py handles sys.path)
/Users/griffinlong/.local/share/uv/tools/harbor/bin/python \
  -m pytest bench/harbor/ -v
```

Tests do not require Docker or an API key — they exercise pure Python logic only.

## Job output layout

Harbor writes results to `bench/harbor/jobs/<job-name>/` (gitignored). Each trial:
- `<trial_name>/result.json` — `verifier_result.rewards.reward` (0.0–1.0)
- `<trial_name>/agent/afk-stream.txt` — raw stream-json NDJSON from `afk chat`
- `<trial_name>/exception.txt` — present on error (e.g. NonZeroAgentExitCodeError)

Quick reward check:
```bash
harbor view bench/harbor/jobs   # web UI at http://localhost:8080
```
