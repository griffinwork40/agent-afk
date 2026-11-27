# Shared workspace A/B: harness complete, experiment NOT run

**Status: HARNESS READY / HOLD.** The full measurement and orchestration
infrastructure is built and tested. No paired model trials have been executed.
No measured distributions, effect sizes, confidence intervals, quality scores
or experiment success are claimed. Deterministic test fixtures do not count as
trials. The earlier single treatment pilot reported on #1539 does not establish
an A/B result.

## #1196 v2 item status on HEAD

| Item | Status | Notes |
|---|---|---|
| `workspace_query` as model tool | ✅ Done | `WORKSPACE_TOOL_NAMES` in `workspace-tools.ts`; wired on all child surfaces |
| Measurement harness | ✅ Done | `scripts/measure-read-dedup.ts` + `scripts/workspace-ab/` |
| A/B experiment runner | ✅ Done | `scripts/run-workspace-ab-test.ts`; blocked on authorized spend (see below) |
| A/B experiment results | ❌ Not run | Blocked — see "Why no experiment was launched" |
| Reactive workspace (auto-publish) | ❌ Not done | Tracked in #1418 (`workspace_subscribe` ships push delivery; auto-publish from tool results is separate) |
| TTL / relevance decay | ❌ Not done | Deferred; no concrete failure mode observed |
| Cross-session persistence | ✅ Won't-fix | Decided in ADR `docs/decisions/0004-workspace-persistence-wont-fix.md` |

## What is built

### Deduplication measurement (`scripts/measure-read-dedup.ts`)

Reads a witness trace and reports cross-agent `read_file` duplication:

```
tsx scripts/measure-read-dedup.ts --latest          # most recent session
tsx scripts/measure-read-dedup.ts --session <id>    # specific session
tsx scripts/measure-read-dedup.ts --file <path>     # raw trace.jsonl
tsx scripts/measure-read-dedup.ts --json            # machine-readable output
tsx scripts/measure-read-dedup.ts --all-tools       # measure all tools, not just read_file
```

Requires `argsFingerprint` on `tool_call` trace events (landed in #1205).

### A/B orchestration (`scripts/run-workspace-ab-test.ts`)

Full paired-trial runner. Invoked via:

```
pnpm experiment:workspace [--model <m>] [--trials <n>] [--dry-run]
```

The runner:
- Requires the afk binary before starting (fail-closed).
- Alternates arm order per trial to reduce warm-cache / rate-limit bias.
- Keeps stdout and stderr separate per arm.
- Validates both traces via `validate()` before comparing.
- Runs ≥ 5 paired trials (configurable, minimum enforced).
- Records model, promptHash, gitSha, nodeVersion, cost, duration, trialOrder.
- Writes a machine-readable manifest + Markdown summary per run.

### Output layout

The runner resolves its default output through `getWorkspaceExperimentDir`
(exported by `src/paths.ts`), honoring `AFK_HOME` and `AFK_STATE_DIR`:

```text
<AFK state>/experiments/workspace-ab/<timestamp-uuid>/
  manifest.json
  report.md
  trial-<index>-control-stdout.json
  trial-<index>-control-stderr.txt
  trial-<index>-treatment-stdout.json
  trial-<index>-treatment-stderr.txt
```

An explicit `--output-dir` override is supported but must name a new,
nonexistent directory: the runner reserves it exclusively before any arm starts,
refusing reuse to prevent overwritten captures or stale trial records. Summary
files are atomic; the manifest is written last. Generated files remain private
state — scrub before publishing any result.

## Credential pre-flight fix (this PR)

The runner's `assertCredentialPresent` previously checked only shell environment
variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), which blocked
execution even when valid credentials existed in the macOS Keychain or
`~/.claude/.credentials.json` (the Claude Code login store).

The check now delegates to `resolveAnthropicCredential()` from
`src/agent/auth/credential-resolver.ts`, which applies the same three-source
precedence walk the afk binary itself uses: shell env → macOS Keychain /
`~/.claude/.credentials.json` → `~/.afk/config/afk.env`.  The dry-run
(`--dry-run`) now succeeds on machines that have logged in via `afk login`
without exporting credentials to the shell.  All 56 unit tests pass; TypeScript
and env-access audits are clean.

## Why no experiment was launched

Paid model experiment calls were not authorized in this pass. The existing runner
defaults to `sonnet` with a $3 per-arm ceiling (ten arms for the minimum five
pairs), not a zero-cost guarantee. A configured `local` slot exists, but it is a
remote OpenAI-compatible endpoint; a slot name alone does not establish cost or
safety. The canonical prompt asks the root to create compose investigators without
pinning all child models. This pass did not verify a bounded,
subscription/local-only configuration for the entire topology, and did not launch
model calls to probe it. No configuration was changed.
Experiment-call spend for this proposal: **$0**.

## Remaining acceptance criteria to close #1196

1. Establish an authorized, safely bounded model/provider configuration for the
   root and every investigator (including tool-round/time limits), or explicitly
   authorize paid spend. Record the full SHA, provider/model identities, prompt
   hash and runtime version before starting.
2. Run **at least five paired trials** with the existing alternating arm order and
   byte-identical prompt. Both arms in every counted pair must pass validation:
   no swallowed failures, absent metrics or missing closure. Preserve all arm
   records and traces in canonical state storage. Retain failed attempts as well.
3. Review citation validity, required-area coverage, unsupported claims, child
   failures and completion status for both arms. The runner's dedup validation is
   not a substitute for this quality evaluation. Cost instrumentation
   (`totalCostUsd` is currently null in manifests) — do not report that as zero.
4. Publish a scrubbed **real results** summary: exact tested SHA, trial count,
   per-arm read-dedup and file-overlap distributions, paired median/mean change
   with confidence interval or range, failure/quality comparison, limitations,
   and a justified proceed/hold decision.
5. File separate follow-up issues (or explicitly decline) for reactive workspace
   (#1418) and TTL/relevance decay. This doc and #1196 remain open until step 4
   is complete.

**Decision: HOLD any conclusion about workspace efficacy.** The harness is ready;
the experiment has not been run.
