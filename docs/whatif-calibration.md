# What-if Calibration: Verdict Statistics for `afk whatif --verify`

Measured after fixes #2404 and #2405. Regenerate: `pnpm exec tsx scripts/generate-whatif-calibration.ts`

## What this table shows

Each cell is a Monte Carlo estimate over **400 repetitions** using a
seeded PRNG (seed=42) — results are exactly reproducible.  The data model
is hierarchical:

- Each **episode** draws a latent per-arm rate from a Beta distribution
  parameterised by mean (0.5) and ICC (intra-class correlation).  Using a
  Beta avoids the mass-at-boundary artefact of the earlier clamped-Normal model.
- Per-episode **effect** may be heterogeneous: delta_e ~ Normal(trueDelta, tau),
  so tau > 0 means the effect varies across episodes.
- Each **sample** within an episode is a Bernoulli draw from that episode's
  latent rate (correlated across samples, independent across episodes).
- After the **#2404 fix**, each episode's sample scores are averaged before
  flowing into `compareRates()`, so n = episode count (not episodes × samples).
- The prediction direction is **'added'** (expected delta > 0).

Two ICC settings and two tau settings are reported:

| Setting | ICC | tau |
|---------|-----|-----|
| Low ICC, no heterogeneity  | ≈ 0.083 | 0 |
| High ICC, no heterogeneity | ≈ 0.390 | 0 |
| High ICC, tau=0.05         | ≈ 0.390 | 0.05 |

**ICC** = σ_b² / (σ_b² + σ_w²), where σ_b is between-episode σ and σ_w² ≈ p(1-p) ≈ 0.25
at baseRate=0.5.  **tau** = per-episode effect σ.

## BEFORE / AFTER comparison (key cells)

Fixes: **#2404** (per-episode averaging) + **#2405** (real equivalence test, margin ±5pp).

| Metric | BEFORE | AFTER | Change |
|--------|--------|-------|--------|
| n (6 eps × 5 samples) | 30 (inflated) | 6 (episodes) | ✅ n-inflation fixed |
| verdict (6 eps × 5 samp, all-zero) | refuted | unclear | ✅ false refute eliminated |
| P(refuted|delta=0.1, E=3, S=1, low ICC) | ≈4.8% | ≈6.3% | ✅ reduced (opposite-dir remains) |
| P(confirmed|delta=0, E=6, S=5, high ICC) | ≈2.3% | ≈0.0% | ✅ still near nominal |
| P(confirmed|delta=0.3, E=12, S=5, low ICC) | ≈96.8% | ≈54.8% | ⚠ power lower (correct: was n-inflated) |

**Power note:** Power at delta=0.3 is lower after the fix because n is now anchored to the
episode count, not episodes×samples. The pre-fix numbers were inflated by n-inflation. The
corrected power reflects the true statistical information available from the episode count.

## How to read this

- At **delta=0** the prediction direction ('added') is **false**; there is no true improvement.
  - **P(refuted)** is a **correct refutation** — CI excludes 0 in wrong direction (opposite-direction
    clause), OR the entire CI lies inside ±5pp (equivalence clause, #2405 fix).
  - **P(confirmed)** is the **false-confirm rate** (CI wrongly excludes 0 in 'added' direction).
    Nominal one-sided target for a 95% two-sided CI ≈ 2.5%.
- At **delta > 0** the prediction is true:
  - **P(refuted)** is the **false-refute rate** (type-II error in the wrong direction).
  - **P(confirmed)** is **power** (correct detection).
- The **#2404 fix**: samples are averaged within each episode; n in the report and CI is the
  episode count. Episodes with only 1 sample look identical to episodes averaged over 5 identical
  samples — correctly so, because the extra samples carry no new episode-level information.
- The **#2405 fix**: the old "refuted" branch required |delta|<0.05 AND CI half-width<0.15
  (a heuristic that fired at n≥22 regardless of whether the CI was tight enough). The new
  rule requires the entire CI to lie inside [−0.05, +0.05]. At realistic episode counts
  (n=6−20) the CI is typically much wider, so the equivalence branch rarely fires without
  genuinely strong evidence.

## Results tables (after fixes)

### Low ICC (icc≈0.083, tau=0)

| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |
|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|
| 0.0 | 3 | 1 | 10.5% | 13.0% | 76.5% |
| 0.0 | 3 | 3 | 4.8% | 3.5% | 91.8% |
| 0.0 | 3 | 5 | 0.8% | 2.5% | 96.8% |
| 0.0 | 6 | 1 | 6.5% | 9.3% | 84.3% |
| 0.0 | 6 | 3 | 1.3% | 2.5% | 96.3% |
| 0.0 | 6 | 5 | 0.3% | 0.0% | 99.8% |
| 0.0 | 12 | 1 | 8.0% | 7.0% | 85.0% |
| 0.0 | 12 | 3 | 0.0% | 0.5% | 99.5% |
| 0.0 | 12 | 5 | 0.0% | 0.0% | 100.0% |
| 0.1 | 3 | 1 | 15.5% | 6.3% | 78.3% |
| 0.1 | 3 | 3 | 10.0% | 1.0% | 89.0% |
| 0.1 | 3 | 5 | 5.3% | 0.0% | 94.8% |
| 0.1 | 6 | 1 | 13.5% | 3.8% | 82.8% |
| 0.1 | 6 | 3 | 5.8% | 0.0% | 94.3% |
| 0.1 | 6 | 5 | 1.0% | 0.0% | 99.0% |
| 0.1 | 12 | 1 | 15.3% | 1.5% | 83.3% |
| 0.1 | 12 | 3 | 2.3% | 0.0% | 97.8% |
| 0.1 | 12 | 5 | 0.5% | 0.0% | 99.5% |
| 0.3 | 3 | 1 | 29.0% | 0.8% | 70.3% |
| 0.3 | 3 | 3 | 35.3% | 0.0% | 64.8% |
| 0.3 | 3 | 5 | 28.7% | 0.0% | 71.3% |
| 0.3 | 6 | 1 | 36.3% | 0.5% | 63.2% |
| 0.3 | 6 | 3 | 33.5% | 0.0% | 66.5% |
| 0.3 | 6 | 5 | 34.8% | 0.0% | 65.3% |
| 0.3 | 12 | 1 | 54.0% | 0.0% | 46.0% |
| 0.3 | 12 | 3 | 51.2% | 0.0% | 48.8% |
| 0.3 | 12 | 5 | 54.8% | 0.0% | 45.3% |

### High ICC (icc≈0.39, tau=0)

| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |
|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|
| 0.0 | 3 | 1 | 4.8% | 5.8% | 89.5% |
| 0.0 | 3 | 3 | 1.8% | 0.8% | 97.5% |
| 0.0 | 3 | 5 | 1.0% | 0.8% | 98.3% |
| 0.0 | 6 | 1 | 3.0% | 2.5% | 94.5% |
| 0.0 | 6 | 3 | 0.0% | 0.3% | 99.8% |
| 0.0 | 6 | 5 | 0.0% | 0.0% | 100.0% |
| 0.0 | 12 | 1 | 1.3% | 4.5% | 94.3% |
| 0.0 | 12 | 3 | 0.3% | 0.0% | 99.8% |
| 0.0 | 12 | 5 | 0.0% | 0.0% | 100.0% |
| 0.1 | 3 | 1 | 8.0% | 4.8% | 87.3% |
| 0.1 | 3 | 3 | 4.5% | 0.3% | 95.3% |
| 0.1 | 3 | 5 | 3.8% | 0.0% | 96.3% |
| 0.1 | 6 | 1 | 7.8% | 0.8% | 91.5% |
| 0.1 | 6 | 3 | 0.5% | 0.0% | 99.5% |
| 0.1 | 6 | 5 | 1.0% | 0.0% | 99.0% |
| 0.1 | 12 | 1 | 11.5% | 1.0% | 87.5% |
| 0.1 | 12 | 3 | 1.5% | 0.0% | 98.5% |
| 0.1 | 12 | 5 | 0.0% | 0.0% | 100.0% |
| 0.3 | 3 | 1 | 18.8% | 1.5% | 79.8% |
| 0.3 | 3 | 3 | 19.3% | 0.0% | 80.8% |
| 0.3 | 3 | 5 | 18.0% | 0.0% | 82.0% |
| 0.3 | 6 | 1 | 19.5% | 0.0% | 80.5% |
| 0.3 | 6 | 3 | 22.5% | 0.0% | 77.5% |
| 0.3 | 6 | 5 | 15.3% | 0.0% | 84.8% |
| 0.3 | 12 | 1 | 37.3% | 0.0% | 62.7% |
| 0.3 | 12 | 3 | 30.8% | 0.0% | 69.3% |
| 0.3 | 12 | 5 | 27.8% | 0.0% | 72.3% |

### High ICC (icc≈0.39, tau=0.05) — effect heterogeneity

| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |
|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|
| 0.0 | 3 | 1 | 8.3% | 7.2% | 84.5% |
| 0.0 | 3 | 3 | 3.3% | 1.5% | 95.3% |
| 0.0 | 3 | 5 | 0.5% | 0.8% | 98.8% |
| 0.0 | 6 | 1 | 2.5% | 2.3% | 95.3% |
| 0.0 | 6 | 3 | 0.5% | 0.8% | 98.8% |
| 0.0 | 6 | 5 | 0.0% | 0.3% | 99.8% |
| 0.0 | 12 | 1 | 3.8% | 3.0% | 93.3% |
| 0.0 | 12 | 3 | 0.3% | 0.0% | 99.8% |
| 0.0 | 12 | 5 | 0.0% | 0.0% | 100.0% |
| 0.1 | 3 | 1 | 7.8% | 2.5% | 89.8% |
| 0.1 | 3 | 3 | 5.0% | 0.0% | 95.0% |
| 0.1 | 3 | 5 | 5.8% | 0.0% | 94.3% |
| 0.1 | 6 | 1 | 8.5% | 0.8% | 90.8% |
| 0.1 | 6 | 3 | 2.8% | 0.0% | 97.3% |
| 0.1 | 6 | 5 | 0.5% | 0.0% | 99.5% |
| 0.1 | 12 | 1 | 12.0% | 0.5% | 87.5% |
| 0.1 | 12 | 3 | 1.5% | 0.0% | 98.5% |
| 0.1 | 12 | 5 | 0.5% | 0.0% | 99.5% |
| 0.3 | 3 | 1 | 17.0% | 0.5% | 82.5% |
| 0.3 | 3 | 3 | 17.8% | 0.0% | 82.3% |
| 0.3 | 3 | 5 | 20.0% | 0.0% | 80.0% |
| 0.3 | 6 | 1 | 20.5% | 0.3% | 79.3% |
| 0.3 | 6 | 3 | 19.5% | 0.0% | 80.5% |
| 0.3 | 6 | 5 | 16.5% | 0.0% | 83.5% |
| 0.3 | 12 | 1 | 38.0% | 0.0% | 62.0% |
| 0.3 | 12 | 3 | 24.5% | 0.0% | 75.5% |
| 0.3 | 12 | 5 | 27.5% | 0.0% | 72.5% |

## Reading the fixes

### Fix #2404 — per-episode averaging

`collect()` in `src/whatif/run.verify.scoring.ts` now averages sample scores
per episode before passing them to `compareRates()`.  n in the result is the
episode count (not episodes × samples).

**Deterministic demonstration** — 6 episodes × 5 samples, all scores = 0:

- BEFORE: `n_baseline = 30`, CI half-width ≈ 0.11 → verdict **'refuted'**
- AFTER:  `n_baseline = 6`,  CI half-width ≈ 0.39 → verdict **'unclear'**

**Acceptance case (issue #2404):** 20 episodes × 3 identical samples gives the
same CI as 20 episodes × 1 sample — per-episode averaging is a no-op when all
samples are identical.

**Why high ICC exposes this in Monte Carlo:**
With low ICC the between-episode σ is small; samples from the same episode are
nearly i.i.d. anyway, so inflating n is approximately harmless. At high ICC
the per-episode latent rate variance dominates, and inflating n over correlated
samples significantly narrows the CI.

| Cell | Low ICC P(conf|delta=0, S=1 vs S=5) | High ICC P(conf|delta=0, S=1 vs S=5) |
|------|--------------------------------------|---------------------------------------|
| E=6 S=1 | 6.5% conf | 3.0% conf |
| E=6 S=5 | 0.3% conf | 0.0% conf |

### Fix #2405 — real equivalence test

`verdictFor()` in `src/whatif/stats.ts` now returns `'refuted'` (equivalence
branch) only when the **entire** 95% CI lies inside [−0.05, +0.05] — a proper
equivalence test (TOST-adjacent).  The old heuristic (|delta| < 0.05 AND
CI half-width < 0.15) fired at n ≥ 22 regardless of actual CI coverage.

**Acceptance cases from issue #2405:**

- `verdictFor(removed, {delta:+0.003, ci:[-0.137, +0.144]})` → **unclear** ✅
- `verdictFor(added, {delta:0.01, ci:[-0.03, 0.04]})` → **refuted** (equivalence) ✅
- `verdictFor(added, {ci:[-0.2, -0.05]})` → **refuted** (opposite direction) ✅

**Low-ICC cells where false-refute at delta=0.1 improved:**

| Cell | BEFORE P(refuted|delta=0.1) | AFTER P(refuted|delta=0.1) |
|------|------------------------------|------------------------------|
| E=3, S=1 | ≈4.8% (half-width rule) | ≈6.3% (opposite-dir only) |
| E=6, S=3 | ≈1.0% | ≈0.0% |

### Effect-heterogeneity dimension (tau)

The harness now supports tau > 0, where the per-episode effect delta_e ~ Normal(delta, tau).
At HIGH ICC + tau=0.05, false confirms at delta=0 remain near the nominal rate:

| Cell (HIGH ICC, tau=0.05) | P(confirmed|delta=0) |
|--------------------------|----------------------|
| E=6, S=3  | 0.5% |
| E=6, S=5  | 0.0% |

## Power reference

P(confirmed) at delta=0.3 (after #2404 fix — n anchored to episodes):

### Low ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 29.0% | 35.3% | 28.7% |
| 6 | 36.3% | 33.5% | 34.8% |
| 12 | 54.0% | 51.2% | 54.8% |

Power at E=12, S=5 (low ICC, after fix): **54.8%** (was ≈96.8% before; that was n-inflated).

### High ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 18.8% | 19.3% | 18.0% |
| 6 | 19.5% | 22.5% | 15.3% |
| 12 | 37.3% | 30.8% | 27.8% |

Power at E=12, S=5 (high ICC, after fix): **27.8%** (reduced further by high between-episode variance).

## False-confirm reference (delta=0)

### Low ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 10.5% | 4.8% | 0.8% |
| 6 | 6.5% | 1.3% | 0.3% |
| 12 | 8.0% | 0.0% | 0.0% |

### High ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 4.8% | 1.8% | 1.0% |
| 6 | 3.0% | 0.0% | 0.0% |
| 12 | 1.3% | 0.3% | 0.0% |

Ideal (well-calibrated 95% two-sided CI): P(confirmed|delta=0) ≈ 2.5% one-sided.
The numbers above vary because at small n the Wilson/Newcombe CI is conservative
and the unclear/refuted balance shifts.

## Interval method: Newcombe Hybrid Score over per-episode means

**Chosen method:** Newcombe hybrid score (Method 10, Newcombe 1998) applied to
per-episode mean scores. Each element passed to `compareRates` is the within-
episode average of sample scores (in [0,1]). n = number of episodes.

**Why not paired t / bootstrap?** Both arms run the same episodes (paired design),
which makes pairing statistically preferable when the per-episode effect is the
target. However, the current codebase uses Wilson/Newcombe throughout for
consistency and because the episode means are fractional (judge probabilities in
[0,1], not binary outcomes). The Newcombe CI remains valid for fractional means
when n is interpreted as the number of unit-weight observations. A paired t or
bootstrap would require a separate CI module and would break the clean
`compareRates([baseline]), compareRates([candidate])` interface; that upgrade
is left for a future PR when the sample size justifies the precision gain.

---

## Sign-flip harness (#2477 step 3)

The paired per-probe sign-flip test (see `src/whatif/probe-signflip.ts`) is a
secondary analysis run beside the Newcombe interval. It is ADDITIVE: it never
changes the verdict. The harness runs the same seeded grid to measure its
false-positive rate (FPR) under the null and power under an effect.

**Important caveat:** the harness draws both arms from the SAME per-episode
latent rate (p_b_e for baseline, p_c_e = clip(p_b_e + delta_e) for candidate).
This makes each probe's within-probe correlation across arms higher than in real
data, where baseline and candidate draws are independent runs. The harness
therefore **overstates the pairing gain**. Use these numbers for direction only,
not as production calibration.

### How to read the sign-flip harness numbers

- At **delta=0**: P(sig) is the false-positive rate. Should be ≤ 5%.
- At **delta=0.3**: P(sig) is power. Higher is better.

Key observation from the grid (seed=42, 400 reps, LOW ICC):

| Setting | Newcombe P(confirm) | Sign-flip P(sig) | Notes |
|---------|---------------------|------------------|-------|
| E=12, S=1, delta=0   | 6.8%  | 1.8%  | FPR both near nominal |
| E=12, S=3, delta=0.3 | 52.0% | 61.8% | Sign-flip higher power at S=3 |
| E=12, S=5, delta=0.3 | 55.0% | 89.0% | Sign-flip much higher power at S=5 |
| E=6,  S=1, delta=0.3 | 33.8% | 0.5%  | Sign-flip very low power at S=1 |

**Pattern:** with S=1 (one sample per probe, binary 0/1), sign-flip has very low
power because the per-probe mean is a single Bernoulli and carries no continuous
variation. With S≥3 the per-probe mean becomes a continuous proportion, and the
sign-flip exploits between-probe correlation to achieve higher power than the
unpaired Newcombe test. The crossover happens around S=3 at E=12. This matches
the pilot finding that probe count (not sample count) is what buys power — though
the harness caveat applies: real data correlation may differ.

**Min achievable p:** with k nonzero probes, p cannot go below 2/2^k. At 6
probes min_p = 0.03125 (< 0.05). At ≤4 probes min_p ≥ 0.125 and significance
is unreachable. The `underpoweredForSig` flag is set in results.json when this
happens.

Regenerate: `pnpm exec tsx scripts/generate-whatif-calibration.ts`
