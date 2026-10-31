# Shared workspace A/B: storage readiness, experiment NOT run

**Status: PARTIAL / HOLD.** This is a readiness note, not a results summary.
No paired model trials were executed for this proposal. No measured distributions,
effect sizes, confidence intervals, quality scores or experiment success are claimed.
Deterministic test fixtures do not count as trials. The earlier single treatment
pilot reported on #1539 does not establish an A/B result.

## Verified scope

The source review started at exact commit
`d97a3747d320eb3d927ca22ab9bad9ba4c8554d1` (the supplied base was verified as an
ancestor of HEAD). This is **not** an experimentally tested commit SHA.
The proposal's tested code SHA and verification commands are recorded in its PR.

The runner now resolves its default output through `getWorkspaceExperimentDir`
(exported by `src/paths.ts`), honoring `AFK_HOME` and `AFK_STATE_DIR`:

```text
<AFK state>/experiments/workspace-ab/<timestamp-uuid>/
  manifest.json
  control/trial-<index>.json
  treatment/trial-<index>.json
  comparison.json
  report.md
  trial-<index>-<arm>-stdout.json
  trial-<index>-<arm>-stderr.txt
```

An explicit `--output-dir` override remains supported, but must name a new,
nonexistent directory: the runner reserves it exclusively before any arm starts,
refusing reuse to prevent overwritten captures or stale trial records. Arm JSON records retain
validation failures, trace identities and available metrics; raw process captures
remain separate. Summary files are atomic, and the manifest is written last.
A run with fewer valid pairs than requested exits nonzero, including validation
failures that return normally rather than throwing. Manifests record full HEAD SHAs.
Generated files remain private state; scrub before publishing any result.

## Why no experiment was launched

Paid model experiment calls were not authorized. The existing runner defaults to
`sonnet` with a $3 per-arm ceiling (ten arms for the minimum five pairs), not a
zero-cost guarantee. A configured `local` slot exists, but it is a remote
OpenAI-compatible endpoint; a slot name alone does not establish cost or safety.
The canonical prompt asks the root to create compose investigators without pinning
all child models. This pass did not verify a bounded, subscription/local-only
configuration for the entire topology, and did not launch model calls to probe it.
No configuration was changed. Experiment-call spend for this proposal: **$0**.

## Exact remaining acceptance on #1539

1. Establish an authorized, safely bounded model/provider configuration for the root
   and every investigator (including tool-round/time limits), or explicitly authorize
   paid spend. Build the exact clean commit to be tested; record its full SHA,
   provider/model identities, prompt hash and runtime version before starting.
2. Run **at least five paired trials** with the existing alternating arm order and
   byte-identical prompt. Both arms in every counted pair must pass validation:
   no swallowed failures, absent metrics or missing closure. Preserve all arm
   records and traces in canonical state storage. Retain failed attempts as well.
3. Review citation validity, required-area coverage, unsupported claims, child
   failures and completion status for both arms. The runner's dedup validation is
   not a substitute for this quality evaluation. Cost instrumentation remains
   incomplete (`totalCostUsd` is currently null); do not report that as zero.
4. Publish a scrubbed **real results** summary here: exact tested SHA, trial count,
   per-arm read-dedup and file-overlap distributions, paired median/mean change
   with confidence interval or range, failure/quality comparison, limitations,
   and a justified proceed/hold decision. Current generated reports are only
   preliminary averages and do not satisfy this complete publication requirement.
5. Only after that evidence exists, update #1196's measurement/experiment/query
   status, point reactive delivery to #1418, and explicitly resolve TTL/persistence
   follow-ups (separate issues or decline in favor of ephemeral workspace plus
   durable `StateStore`). This proposal does not close #1539 or #1196.

**Decision: HOLD any conclusion about workspace efficacy.** Proceed only with
storage readiness review; the actual experiment and parent closure remain open.
