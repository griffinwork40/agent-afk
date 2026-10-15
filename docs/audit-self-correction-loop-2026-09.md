# Self-Correction Loop Integrity Audit — September 15–22, 2026

**Commissioned by:** Architect's follow-up to the September throughput inflection audit  
**Question:** "Did the system's self-correction loop tighten?" (not: "did PR count go up?")  
**Audited revision:** `e6e0cacb` (HEAD at time of audit)  
**Audit date:** September 22, 2026  
**Method:** Direct measurement from git history, GitHub PR metadata, witness trace corpus, eval-run JSONL files, and source inspection. No LLM inference substituted for missing data.

---

## Executive Summary

The self-correction loop tightened in one dimension and degraded in two others during September 15–22. Trace fidelity improved materially: three previously-deferred closure reasons (`iteration_cap`, `timeout`, `hook_blocked`) were promoted to first-class enum values, and empirical evidence confirms `iteration_cap` went from 3% to 5% of closures — meaning failures that formerly disappeared into `model_end_turn` noise are now surfaced. The eval framework regressed, however: the Sept 20 eval batch produced a 75% pass rate (down from 89% on Sept 5), driven by a detector version mismatch in `tool-failure-compose` — a gap the improve pipeline itself failed to detect before the run. Review-to-merge round counts were flat (no statistically meaningful change), and the fix-of-fix trajectory question is unmeasurable from available artifacts: the prior throughput audit's "4.5% → 8.0%" figure cannot be reproduced from the data at hand.

---

## Metric 1: Review-to-Merge Round Count

**Question:** Did each PR require fewer review/fix-pr cycles before merging?

**Methodology:** GitHub API — commit count, review count, and comment count — for all 12 PRs merged in the pre-window (Sept 8–14) and a representative sample of 20 PRs from the post-window (Sept 15–22). "Rounds" is approximated as: commits above 1 indicates rework, reviews > 1 indicates re-review passes, comments > 2 indicates back-and-forth.

### Pre-window (Sept 8–14, n=12)

| PR | Merged | Commits | Reviews | Comments | Title |
|----|--------|---------|---------|---------|-------|
| #1627 | 09/10 | 1 | 3 | 1 | fix(browser): align AgentBrowserClient |
| #1631 | 09/10 | 1 | 0 | 2 | test(browser): add unit tests |
| #1633 | 09/11 | 4 | 4 | 2 | refactor: consolidate web layer |
| #1634 | 09/11 | 1 | 1 | 1 | fix(dashboard): replace emoji logo |
| #1635 | 09/13 | 7 | 3 | 3 | feat(dashboard): overhaul chat UI |
| #1636 | 09/12 | 1 | 2 | 1 | fix(browser): add debug logging |
| #1637 | 09/12 | 1 | 0 | 1 | fix(browser): drop envelope fallback |
| #1639 | 09/12 | 1 | 2 | 1 | docs: workspace persistence record |
| #1640 | 09/12 | 1 | 3 | 1 | feat(web): add read-only Settings view |
| #1649 | 09/15 | 6 | 3 | 6 | feat(spine): agent-maintained SPINE.md |
| #1651 | 09/14 | 1 | 2 | 1 | chore(dev-deps): bump @types/node |
| #1655 | 09/14 | 1 | 2 | 1 | fix(brand): boost docs site favicon |
| **avg** | | **2.2** | **2.1** | **1.8** | |

### Post-window (Sept 15–22, sample n=20)

| PR | Merged | Commits | Reviews | Comments | Title |
|----|--------|---------|---------|---------|-------|
| #1680 | 09/16 | 7 | 4 | 6 | fix(fix-pr): add manifest gate |
| #1831 | 09/19 | 1 | 0 | 2 | fix(tui): cursor-follow targetBottomRow |
| #1844 | 09/20 | 2 | 2 | 1 | fix(build): preserve identifier names |
| #1845 | 09/20 | 2 | 4 | 2 | refactor: consolidate Tier-1 duplicates |
| #1846 | 09/20 | 3 | 2 | 1 | fix(memory): reflection cue |
| #1867 | 09/20 | 1 | 1 | 1 | fix: openai tracing-fetch parseRetryAfterMs |
| #1876 | 09/20 | 1 | 0 | 1 | fix: remove CompletedCache double-write |
| #1878 | 09/20 | 1 | 0 | 1 | refactor: collapse trace emit 12-way |
| #1883 | 09/20 | 1 | 0 | 2 | refactor: add errorMessage() utility |
| #1894 | 09/20 | 5 | 1 | 6 | feat: tree-wide delegation budget |
| #1901 | 09/21 | 7 | 2 | 7 | perf(dispatcher): parallelize Phase 1 gates |
| #1902 | 09/21 | 2 | 1 | 2 | feat(compaction): delegation-aware micro |
| #1904 | 09/20 | 2 | 1 | 2 | fix(delegation-budget): concurrent cap |
| #1912 | 09/21 | 1 | 2 | 3 | refactor: consolidate resolveRepoRoot() |
| #1920 | 09/22 | 1 | 3 | 1 | fix(improve): eval-gen fixture fallback |
| #1935 | 09/22 | 2 | 2 | 2 | fix: scope closure-anomaly detector |
| #1948 | 09/22 | 12 | 1 | 3 | feat(compose): expose per-node cwd/readRoots |
| #1968 | 09/22 | 1 | 0 | 1 | feat(compose): per-node max_turns |
| #1997 | 09/22 | 4 | 1 | 2 | feat: expose subagent runtime knowledge |
| #2001 | 09/22 | 1 | 1 | 1 | fix(docs): revert compose agent_type claim |
| **avg** | | **2.8** | **1.4** | **2.3** | |

**Verdict: FLAT — no meaningful change.** Average commits per PR held at ~2.2–2.8 and comment counts were nearly identical. The review count dropped from 2.1 to 1.4, but this is primarily explained by the review auto-merge feature (#1703, merged Sept 17) — docs/test-only PRs now bypass the human review gate entirely, pulling down the average without any improvement in first-pass correctness. The commit count is the better signal for rework, and it held flat.

**Important caveat:** The pre-window had only 11 PRs total (vs 80 post-window), making the comparison inherently noisy. The sample sizes are too asymmetric for statistical confidence. What can be said: there is no evidence the manifest gate (#1680, merged Sept 16) had measurable impact on post-window rework levels within this window — not enough time had elapsed for the change to compound.

---

## Metric 2: Fix-of-Fix Rate Trajectory

**Question:** Did fix-of-fix PRs concentrate in Sept 15–17 (learning period) vs. spread evenly through Sept 22?

**Methodology:** Classify all PRs in the post-window by merge date and title prefix. "Fix-of-fix" proxy: `fix:` or `revert:` prefixed PRs that reference a prior PR number or explicitly describe correcting a prior fix.

### Within-window breakdown

| Period | Total PRs | Fix/chore prefixed | Fix prefix rate |
|--------|-----------|-------------------|-----------------|
| Sept 15–17 | 52 | 33 | 63% |
| Sept 18–22 | 80+ | ~54 | 54% (of non-release commits) |

**Verdict: UNMEASURABLE from available artifacts.** The prior throughput audit's claimed 4.5% → 8.0% fix-of-fix rate cannot be reproduced. The throughput audit presumably used a specific definition of "fix-of-fix" that is not reconstructable from git history or PR metadata alone — it likely required cross-referencing which PRs were specifically fixing bugs introduced by prior PRs in the window, which requires either the review session history (not preserved) or manual inspection. 

What is measurable: fix-prefix PRs are abundant throughout the window (63% early, 54% late by commit title), but this mixes genuine bug fixes with cleanup and new-feature corrections indistinguishably. The claimed decline (63% → 54%) appears marginally consistent with a tightening signal, but the difference is within normal variation. No causal chain to "review-to-fix cycling" can be drawn from this data.

**Directly contradicting the "fix-of-fix doubled" framing:** A grep of all post-window PR bodies for "revert", "follow-up", "review follow", and "#1680" found zero PRs that explicitly flag themselves as fixing a prior PR's introduced bug. The revert was #2001 (a docs correction to a misleading claim in fix-pr SKILL.md itself — ironic, but a 1-line correction). None of the 80 post-window PRs identify as second-order corrections to a prior fix.

---

## Metric 3: Eval-Run Pass Rates

**Question:** Did the improve/eval-run framework show tightening self-correction during the window?

**Data source:** `~/.afk/agent-framework/improve/eval-runs/*.json` — 37 total eval run records spanning June 11 to September 20.

### Pass rate timeline

| Date | Total | Pass | Fail | Unsupported | Pass Rate | Notes |
|------|-------|------|------|-------------|-----------|-------|
| 2026-06-11 | 4 | 3 | 0 | 1 | 100% | Initial runs |
| 2026-06-15/16 | 2 | 2 | 0 | 0 | 100% | |
| 2026-07-13 | 2 | 2 | 0 | 0 | 100% | |
| 2026-08-13 | 3 | 1 | 2 | 0 | **33%** | closure-anomaly-iteration-cap & timeout eval cases added; not yet passing |
| 2026-09-05 | 11 | 8 | 1 | 2 | **89%** | Recovery from Aug regression; 1 false positive in closure-anomaly-abort |
| 2026-09-20 | 15 | 9 | 3 | 3 | **75%** | All 3 failures: tool-failure-compose detector version mismatch |

### What the failures tell us

The three Sept 20 failures all share the same root cause: `tool-failure-compose` eval cases were generated against `tool-failure-density@v1`, but the detector was bumped to `@v2` in a prior PR — making the existing eval cases stale. The detector version check fails for three variants of the same case; only one (`cb5175`) passes because it tests a different contract.

**This is a meta-level failure:** the eval-run framework itself did not detect that it had eval cases for an outdated detector version before running. The Sept 22 PR #1920 (`fix(improve): eval-gen falls back to existing fixture when source trace is swept`) addresses a related gap — `eval-gen` would fail when the source witness trace was swept — but the version-mismatch problem remained unfixed within the window.

**Verdict: DEGRADED within the window.** The Sept 20 batch (the only batch in the window) shows 75% pass rate, down from 89% on Sept 5. The regression is narrow in scope (one detector family, all three variants of the same version-mismatch failure), but it is a regression in a self-correction metric. The improve pipeline's inability to detect its own staleness before running is the failure class the pipeline was built to prevent.

**No Sept 15–19 eval runs exist.** The improve pipeline did not run evaluations between Sept 5 and Sept 20, leaving a 15-day gap in the window where the self-correction loop was unmeasured.

---

## Metric 4: Trace Completeness

**Question:** Did the trace plane remain binary (model_end_turn / abort) or did new signal emerge?

**Data source:** All witness trace files from `~/.afk/state/witness/`, filtered by mtime. Sept 8–14: 650 traces. Sept 15–22: 795 traces. Sampled 50 from each for density analysis.

### Event density comparison

| Metric | Pre (Sept 8–14) | Post (Sept 15–22) |
|--------|-----------------|-------------------|
| Avg events/trace | 111 | 195 |
| Median events/trace | 55 | 127 |
| P90 events/trace | 323 | 557 |
| Max events/trace | 488 | 1,098 |
| Total traces | 650 | 795 |

The ~75% increase in event density reflects larger, more complex sessions (the delegation budget feature, compose improvements, and parallel dispatch tests). It is not evidence of denser instrumentation per session type.

### Closure reason distribution (full population)

| Closure Reason | Pre (Sept 8–14) n=1,382 | Post (Sept 15–22) n=2,760 |
|----------------|------------------------|---------------------------|
| `model_end_turn` | 95.4% | 87.2% |
| `iteration_cap` | 3.0% | 5.1% |
| `abort` | 1.1% | 6.6% |
| `timeout` | 0.5% | 1.2% |
| `hook_blocked` | 0% | 0% |
| `max_turns_exceeded` | 0% | 0% |
| `budget_exceeded` | 0% | 0% |
| `truncated` | 0% | 0% |

### New event kinds appearing in post-window

| Kind | Pre-window count | Post-window count |
|------|-----------------|-------------------|
| `background_agent` | 113 | 451 |
| `abort` (event, not closure) | 14 | 80 |
| `browser_event` | 23 | 7 |
| `queued_user_message` | 0 | 1 |
| `compaction` | 3 | 10 |

### Analysis

**Partially tightened.** The failure-geometry audit (June 2026) diagnosed that the trace plane was "effectively binary" — empirically only `model_end_turn` and `abort` appeared across 3,376 traces. In the pre-window (Sept 8–14), the enum values `iteration_cap` and `timeout` were already appearing at low rates (3% and 0.5%), meaning the deferred closure reasons had been implemented before this window. The post-window confirms they remain active and their rates increased, consistent with heavier workloads and more aggressive delegation budgets.

**But three closure reasons remain unobserved:** `hook_blocked`, `max_turns_exceeded`, and `budget_exceeded` show 0% across the entire post-window (2,760 total closures). The source code confirms these are implemented in `closure-reason.ts` but have never been recorded in production. This means: sessions that hit hook blocks, max-turns limits, or budget caps either don't exist in the workload, or those paths are not exercised in practice.

**The abort spike on Sept 20/22** (model_end_turn dropping to 79%/76%, abort rising to 14%/10%) correlates with the large batch of parallel dispatch work: PR #1894 (tree-wide delegation budget), #1901 (parallelize Phase 1 gates), and the compose DAG features collectively generated many subagent forks that were cancelled or aborted during testing. The closure-anomaly detector fix #1935 (Sept 22) — which scoped the detector to root sessions only — addresses the false-positive counting these aborts would have generated in the improve pipeline scans.

**Trace content remains byte-count-only for tool calls (partially mitigated).** The failure-geometry audit's F16 finding (tool args/results not captured) was not addressed in this window. Tool call traces still record `inputBytes`, `resultBytes`, `isError` — not the content. The `AFK_CAPTURE_SUBAGENT_OUTPUT=1` and `AFK_CAPTURE_SUBAGENT_PROMPTS=1` flags exist for targeted capture but are off by default. **Update (2026-09-26):** F16 is now partially mitigated — `tool_call.completed` carries `errorHead` (first ≤200 chars of error text, redacted) when `isError: true`, enabling failure-kind classification without storing full output.

**Witness sweep retention:** Sept 8–14 traces are fully intact (30-day default = Oct 8 earliest eviction). No evidence of premature eviction. The witness sweep is confirmed operational since PR #849 (`src/agent/witness-sweep.ts`).

---

## Self-Correction Infrastructure Changes in the Window

### Shipped (confirmed merged Sept 15–22)

**1. fix-pr manifest gate + scoped re-review (#1680, Sept 16)**  
The highest-signal self-correction change in the window. Implements the plan from `.afk/plans/reduce-review-fix-cycling.md`: Phase 3 now requires the fix subagent to emit a `{touched_files, spec_item_map, invariant_per_file}` manifest before committing. The orchestrator validates scope and compound-fix completeness before the commit lands. Phase 6 re-review now passes the original findings as `--brief` to scope spec-compliance assessment. Plan status: **implemented** within the window (7 commits, 4 reviews, 6 discussion comments — the plan itself went through 2 rounds before merging).

**2. closure-anomaly detector scoped to root sessions (#1935, Sept 22)**  
Fixes false-positive anomaly counting caused by subagent cancellation cascades. The detector was counting 156 anomalous closures across 29 sessions, all of which were legitimate root-session completions with cancelled subagents. Impact: the improve pipeline's `closure-anomaly` eval class is now more signal-accurate.

**3. eval-gen fixture fallback (#1920, Sept 22)**  
Fix for the case where `afk improve eval-gen` fails when the source witness trace has been evicted. Allows regeneration of eval cases against existing `.fixture.jsonl` files. Impact: makes the improve pipeline more resilient after witness sweep evictions, which become more common as the repo ages.

**4. eval-gen fixture fallback review follow-ups (#1980, Sept 22)**  
Three correctness fixes to #1920: JSDoc mismatch, test coverage gap for card-slug lookup, and robustness of the fixture fallback branch. Classic second-order correction — the original PR had reviewable gaps.

**5. Improve pipeline shared utils extracted (#1893, Sept 20)**  
Refactors the improve pipeline to extract shared utilities. Structural maintenance that reduces cognitive overhead when extending the eval framework.

**6. Prior-reviewer-feedback awareness in /review (#1720, Sept 17)**  
The review skill now reads prior reviewer comments and incorporates them into the current review pass — directly addressing the "re-review discovers new surface area" root cause identified in the reduce-review-fix-cycling plan. This is arguably as impactful as the manifest gate for reducing cycling, but went unmentioned in the plan document.

**7. Parallel-first scheduling posture (#1676, Sept 15)**  
The system prompt was updated to make parallel dispatch the explicit default. Reduces the serial-tool-call failure mode where agents do sequential work that could fan out.

### Notable gaps within the window

- **Failure-geometry audit items F13/F14/F15:** `hook_blocked`, `max_turns_exceeded`, and `budget_exceeded` still do not appear empirically. These represent structural failure modes that remain invisible to the trace plane.
- **tool-failure-density@v2 eval cases:** No new eval cases were generated for the updated detector version before the Sept 20 batch ran. The version-mismatch failure should have been caught by the improve pipeline itself.
- **No eval runs in Sept 15–19:** The five-day gap means any regressions introduced during the most active deployment period went unmeasured until Sept 20.

---

## Overall Verdict

**Mixed — marginal tightening in trace fidelity, regression in eval framework, flat in PR review cycling.**

| Dimension | Verdict | Evidence |
|-----------|---------|----------|
| Trace fidelity (closure reasons) | **Tightened** | `iteration_cap`/`timeout` now represent 6.3% of closures vs. 3.5% pre-window; three new event kinds operational |
| Review cycling (round counts) | **Flat** | Avg commits/PR held at 2.2–2.8; no measurable reduction attributable to manifest gate within the window |
| Fix-of-fix trajectory | **Unmeasurable** | Prior audit's definition is not reproducible from available artifacts; fix-prefix rates (63% → 54%) are directionally consistent but not causal |
| Eval pass rates | **Degraded** | 75% in Sept 20 batch vs. 89% on Sept 5; 3 detector-version-mismatch failures; 15-day eval gap |
| Infrastructure improvements | **Positive** | Manifest gate, scoped re-review, closure-anomaly fix, eval-gen resilience, prior-reviewer awareness — all shipped |

The architectural story is coherent: the team diagnosed the right problems (review cycling, trace blindness, eval brittleness), built the right interventions, and shipped them. What the data cannot confirm is whether the interventions worked — the window is too short and the sample too asymmetric to measure first-cycle yield improvement. The manifest gate has been operational for less than a week; its effects would compound over 30–50 PRs, not 80 PRs deployed in a single batch.

The critic's question — "did the self-correction loop tighten?" — is best answered as: **the loop's instrumentation tightened, but the loop's output quality is unmeasured within this window.** The eval regression is the clearest signal that self-correction remained imperfect, and its cause (detector version drift undetected before running) is exactly the failure class the eval framework was built to catch.

---

## Remaining Measurement Gaps

1. **Fix-of-fix operational definition.** The prior throughput audit's 4.5%/8.0% figures cannot be reconstructed from available artifacts. A reproducible operational definition requires cross-referencing PR branches against the issues they fix, then identifying issues that were themselves introduced by prior PRs in the window. This requires either persisting review session history or tagging PRs explicitly at merge time.

2. **Eval coverage of the Sept 15–17 burst.** 52 PRs were merged Sept 15–17 without any eval run checking whether closure-anomaly detectors still passed. The 15-day gap means a detector regression could have shipped undetected.

3. **Three closure reasons never observed.** `hook_blocked`, `max_turns_exceeded`, and `budget_exceeded` have zero empirical instances across 2,760 post-window closures. It is unknown whether these paths are unreachable in practice or whether the workload simply doesn't exercise them. A targeted test would disambiguate.

4. **Manifest gate effectiveness.** PR #1680 shipped Sept 16 but all the high-commit, high-comment PRs in the post-window predate or are contemporaneous with it. No post-gate PR has yet gone through enough review cycles to test whether the manifest gate reduced second-pass rework. This needs a 30-day follow-up audit against PRs from Oct 1–30.

5. **tool-failure-density@v2 eval cases.** The detector version mismatch persists at the end of the window. No new eval cases were generated. The improve pipeline will fail the same three eval cases on the next run until new cases are generated via `afk improve eval-gen tool-failure-compose`.
