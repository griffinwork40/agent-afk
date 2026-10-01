# AFK Eval Program

This document specifies the external benchmark evaluation program for agent-afk.
Internal runtime property benchmarks (subagent dispatch latency, memory store throughput, etc.)
live in `docs/benchmarks/` and are separate from the external behavioral benchmarks here.

## Benchmark Table

| Suite | Capability Probed | Arms | Fixed Model | Sample × Trials | Est. Cost | Cadence | Public Submission |
|-------|-------------------|------|-------------|-----------------|-----------|---------|-------------------|
| Terminal-Bench | Shell task completion, code execution, filesystem manipulation | afk-full, afk-minimal, claude-code | claude-sonnet-4-5 | 20 tasks × 2 trials | ~$15–40 | Per major release | ⚠ See note |
| Terminal-Bench (full) | Same — full split | afk-full, afk-minimal, claude-code | claude-sonnet-4-5 | full split × 1 trial (count varies by release; TB 2.0 = 89) | ~$300–600 per arm | Quarterly | ⚠ See note |
| GAIA | Multi-step reasoning, web + tool use, factual retrieval | afk-full, afk-minimal, claude-code | claude-sonnet-4-5 | 20 tasks × 2 trials | ~$20–60 | Per major release | ⚠ See note |
| SWE-bench Pro | Real-world software engineering: bug fixes on live repos | afk-full, afk-minimal | claude-sonnet-4-5 | 10 tasks × 1 trial | ~$50–150 | Quarterly | ⚠ See note |

### Arm Definitions

| Arm | Description |
|-----|-------------|
| `afk-full` | Full AFK framework prompt + all tools (agent/skill/compose dispatch enabled) |
| `afk-minimal` | `AFK_FRAMEWORK_PROMPT_FILE=/tmp/afk-empty-framework-prompt.txt` (empty prompt) + `AFK_MAX_NESTING_DEPTH=0` (dispatch tools disabled). Removes the framework prompt and delegation; builtin tools, tool descriptions, and any cwd `AFK.md` overlay remain. Ablation to isolate the framework contribution. Not a bare-model arm. |
| `claude-code` | Harbor built-in `claude-code` agent; same model. Comparison baseline. |
| `terminus-2` (optional) | Harbor built-in agentic baseline; run when available on Hub. |

## Gating Rule

**Always run a 10–20 task stratified sample before any full Terminal-Bench run.**

A full Terminal-Bench run at claude-sonnet-4-5 is estimated at $300–600 per arm (unverified estimate; measure cost per task on the sample first). A stratified sample on 10–20 tasks provides sufficient signal to abort if the adapter is misconfigured or costs are anomalous.

```bash
# Sample run — verify adapter works and cost/turn is reasonable before full run
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d terminal-bench --n-tasks 15 \
  --model anthropic/claude-sonnet-4-5 \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -o bench/harbor/jobs
```

Proceed with full run only if: (a) all tasks complete without adapter errors, (b) mean cost per task ≤ $1.50, (c) pass rate on the sample is plausible (>0%).

## Public Submission Status

**Terminal-Bench:**
- Harbor Hub offers continuous Terminal-Bench runs accessible at https://hub.harborframework.com.
- Terminal-Bench 2.1 community submissions are **closed**; only maintainer-run results are added (source: harbor-framework/terminal-bench-2-1 README, checked 2026-09-30).
- The continuous Terminal-Bench release has a Harbor Hub leaderboard; whether community uploads appear on it is **not verified**. `harbor run --upload --public` publishes trajectories (including the afk system prompt) publicly; check the Hub policy before relying on it for a leaderboard row.

**SWE-bench Verified:**
- The swe-bench/experiments leaderboard requires **academic affiliation + arXiv paper** since 2025-11-18 (source: swe-bench/experiments README, `CONTRIBUTING.md`).
- Open-source projects without an academic affiliation cannot submit to the Verified leaderboard.
- Harbor's `swe-bench-pro` dataset runs locally; results are not submittable to the public Verified leaderboard.

**GAIA:**
- The GAIA Hugging Face leaderboard space exists (https://huggingface.co/spaces/gaia-benchmark/leaderboard, last modified 2026-05); whether it currently accepts submissions is **not verified**.
- Harbor's GAIA adapter uses the **validation** split (165 tasks, public answers), which can be scored locally. A leaderboard row requires the **test** split, whose answers are private and are scored only by the leaderboard. Local validation scores are self-reported.
- Validation answers are public, so a web-enabled agent can in principle find them; treat validation scores as an upper bound.

**Princeton HAL:**
- `princeton-pli/hal-harness` is archived and no longer accepts new results (README, checked 2026-09-30). Do not use.

## What These Benchmarks Do NOT Cover

The external benchmark suite measures task completion on standardized datasets. It does **not** cover:

- **Cross-session memory** (`memory_update` / `memory_search` persistence across sessions)
- **Scheduled tasks** (cron/daemon correctness, reliability under OS supervision)
- **MCP server integration** (third-party tool correctness, MCP protocol conformance)
- **Subagent fan-out** (parallelism correctness, budget governor under concurrent dispatch)
- **Telegram / AFK push notifications** (delivery reliability, formatting)
- **Worktree isolation** (git state correctness in managed worktrees)
- **Internal eval infrastructure** (eval-run replay, witness trace fidelity)

These are covered by the **internal benchmarks** in `docs/benchmarks/` and the eval-run program (`docs/improve-eval-run.md`).

## Running the Eval Program

See `bench/harbor/README.md` for full runnable commands.

Quick reference — first live smoke test (requires `ANTHROPIC_API_KEY`):

```bash
PYTHONPATH=. harbor run \
  -a bench.harbor.afk_agent:AfkAgent \
  -d terminal-bench \
  --n-tasks 1 \
  --model anthropic/claude-sonnet-4-5 \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -o bench/harbor/jobs
```

## Results Storage and Interpretation

Results land in `bench/harbor/jobs/<job-name>/`. Each trial directory has:

- `agent/afk-stream.txt` — raw NDJSON stream from `afk chat --format stream-json`
- `result.json` — structured trial result; the reward is at `.verifier_result.rewards.reward`
- `verifier/` — task-specific verifier output

Read pass rate across a job:

```bash
jq -s '[.[] | .verifier_result.rewards.reward // 0] | (map(select(. >= 1)) | length) / length' \
  bench/harbor/jobs/<job>/*/result.json
```

Compare two arms:

```bash
python bench/harbor/compare.py bench/harbor/jobs/afk-full-... bench/harbor/jobs/claude-code-...
```

## Model Selection Policy

All external benchmarks run at a single fixed model (`claude-sonnet-4-5`) per evaluation run. Do not mix models within a job. To compare models, run separate jobs and label them clearly.

Rationale: model drift between arms would confound the framework-contribution signal that the full/minimal ablation is designed to isolate.
