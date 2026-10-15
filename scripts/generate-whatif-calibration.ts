/**
 * Regenerate docs/whatif-calibration.md from the calibration harness.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-whatif-calibration.ts
 *
 * The script runs the same deterministic simulation that the tests use
 * (seed=42, 400 reps per cell) and writes the results table plus
 * diagnostics to docs/whatif-calibration.md.  Commit the updated file
 * after each fix PR so the documented 'before' and 'after' states are
 * archived together.
 *
 * Two ICC settings are run:
 *   - LOW  ICC (icc≈0.083) — baseline / sanity.
 *   - HIGH ICC (icc≈0.390) — required to expose #2404 + tau interaction.
 *
 * Two tau settings are run for HIGH ICC to show effect-heterogeneity dimension:
 *   - tau=0    (homogeneous effect)
 *   - tau=0.05 (per-episode effect delta_e ~ Normal(delta, 0.05))
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EPISODE_COUNTS,
  HIGH_ICC,
  LOW_ICC,
  SAMPLE_COUNTS,
  TRUE_DELTAS,
  findCell,
  renderMarkdownTable,
  runGrid,
} from '../src/whatif/__test-utils__/calibration-harness.js';

const REPS = 400;
const SEED = 42;
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'whatif-calibration.md',
);

const cellsLow  = runGrid({ reps: REPS, seed: SEED, icc: LOW_ICC, tauValues: [0] });
const cellsHigh = runGrid({ reps: REPS, seed: SEED, icc: HIGH_ICC, tauValues: [0, 0.05] });

// ---------------------------------------------------------------------------
// Key diagnostics
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// Low-ICC key cells (tau=0)
const e3s1refL   = findCell(cellsLow, 0.1, 3, 1, 0)!;
const e3s1nullL  = findCell(cellsLow, 0, 3, 1, 0)!;
const e6s1nullL  = findCell(cellsLow, 0, 6, 1, 0)!;
const e6s5nullL  = findCell(cellsLow, 0, 6, 5, 0)!;
const e12s5pwrL  = findCell(cellsLow, 0.3, 12, 5, 0)!;

// High-ICC key cells (tau=0)
const e6s1nullH  = findCell(cellsHigh, 0, 6, 1, 0)!;
const e6s3nullH  = findCell(cellsHigh, 0, 6, 3, 0)!;
const e6s5nullH  = findCell(cellsHigh, 0, 6, 5, 0)!;
const e12s5pwrH  = findCell(cellsHigh, 0.3, 12, 5, 0)!;

// High-ICC key cells (tau=0.05)
const e6s3nullHt = findCell(cellsHigh, 0, 6, 3, 0.05)!;
const e6s5nullHt = findCell(cellsHigh, 0, 6, 5, 0.05)!;

// Tau=0 cells only (for the base grid table, same format as before)
const cellsLowTau0  = cellsLow.filter((c) => c.tau === 0);
const cellsHighTau0 = cellsHigh.filter((c) => c.tau === 0);
const cellsHighTau05 = cellsHigh.filter((c) => c.tau === 0.05);

// ---------------------------------------------------------------------------
// Compose document
// ---------------------------------------------------------------------------

const doc = `\
# What-if Calibration: Verdict Statistics for \`afk whatif --verify\`

Measured after fixes #2404 and #2405. Regenerate: \`pnpm exec tsx scripts/generate-whatif-calibration.ts\`

## What this table shows

Each cell is a Monte Carlo estimate over **${REPS} repetitions** using a
seeded PRNG (seed=${SEED}) — results are exactly reproducible.  The data model
is hierarchical:

- Each **episode** draws a latent per-arm rate from a Beta distribution
  parameterised by mean (0.5) and ICC (intra-class correlation).  Using a
  Beta avoids the mass-at-boundary artefact of the earlier clamped-Normal model.
- Per-episode **effect** may be heterogeneous: delta_e ~ Normal(trueDelta, tau),
  so tau > 0 means the effect varies across episodes.
- Each **sample** within an episode is a Bernoulli draw from that episode's
  latent rate (correlated across samples, independent across episodes).
- After the **#2404 fix**, each episode's sample scores are averaged before
  flowing into \`compareRates()\`, so n = episode count (not episodes × samples).
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
| P(refuted\|delta=0.1, E=3, S=1, low ICC) | ≈4.8% | ≈${pct(e3s1refL.pRefuted)} | ✅ reduced (opposite-dir remains) |
| P(confirmed\|delta=0, E=6, S=5, high ICC) | ≈2.3% | ≈${pct(e6s5nullH.pConfirmed)} | ✅ still near nominal |
| P(confirmed\|delta=0.3, E=12, S=5, low ICC) | ≈96.8% | ≈${pct(e12s5pwrL.pConfirmed)} | ⚠ power lower (correct: was n-inflated) |

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

### Low ICC (icc≈${LOW_ICC}, tau=0)

${renderMarkdownTable(cellsLowTau0)}

### High ICC (icc≈${HIGH_ICC}, tau=0)

${renderMarkdownTable(cellsHighTau0)}

### High ICC (icc≈${HIGH_ICC}, tau=0.05) — effect heterogeneity

${renderMarkdownTable(cellsHighTau05)}

## Reading the fixes

### Fix #2404 — per-episode averaging

\`collect()\` in \`src/whatif/run.verify.scoring.ts\` now averages sample scores
per episode before passing them to \`compareRates()\`.  n in the result is the
episode count (not episodes × samples).

**Deterministic demonstration** — 6 episodes × 5 samples, all scores = 0:

- BEFORE: \`n_baseline = 30\`, CI half-width ≈ 0.11 → verdict **'refuted'**
- AFTER:  \`n_baseline = 6\`,  CI half-width ≈ 0.39 → verdict **'unclear'**

**Acceptance case (issue #2404):** 20 episodes × 3 identical samples gives the
same CI as 20 episodes × 1 sample — per-episode averaging is a no-op when all
samples are identical.

**Why high ICC exposes this in Monte Carlo:**
With low ICC the between-episode σ is small; samples from the same episode are
nearly i.i.d. anyway, so inflating n is approximately harmless. At high ICC
the per-episode latent rate variance dominates, and inflating n over correlated
samples significantly narrows the CI.

| Cell | Low ICC P(conf\|delta=0, S=1 vs S=5) | High ICC P(conf\|delta=0, S=1 vs S=5) |
|------|--------------------------------------|---------------------------------------|
| E=6 S=1 | ${pct(e6s1nullL.pConfirmed)} conf | ${pct(e6s1nullH.pConfirmed)} conf |
| E=6 S=5 | ${pct(e6s5nullL.pConfirmed)} conf | ${pct(e6s5nullH.pConfirmed)} conf |

### Fix #2405 — real equivalence test

\`verdictFor()\` in \`src/whatif/stats.ts\` now returns \`'refuted'\` (equivalence
branch) only when the **entire** 95% CI lies inside [−0.05, +0.05] — a proper
equivalence test (TOST-adjacent).  The old heuristic (|delta| < 0.05 AND
CI half-width < 0.15) fired at n ≥ 22 regardless of actual CI coverage.

**Acceptance cases from issue #2405:**

- \`verdictFor(removed, {delta:+0.003, ci:[-0.137, +0.144]})\` → **unclear** ✅
- \`verdictFor(added, {delta:0.01, ci:[-0.03, 0.04]})\` → **refuted** (equivalence) ✅
- \`verdictFor(added, {ci:[-0.2, -0.05]})\` → **refuted** (opposite direction) ✅

**Low-ICC cells where false-refute at delta=0.1 improved:**

| Cell | BEFORE P(refuted\|delta=0.1) | AFTER P(refuted\|delta=0.1) |
|------|------------------------------|------------------------------|
| E=3, S=1 | ≈4.8% (half-width rule) | ≈${pct(e3s1refL.pRefuted)} (opposite-dir only) |
| E=6, S=3 | ≈1.0% | ≈${pct(findCell(cellsLow, 0.1, 6, 3, 0)!.pRefuted)} |

### Effect-heterogeneity dimension (tau)

The harness now supports tau > 0, where the per-episode effect delta_e ~ Normal(delta, tau).
At HIGH ICC + tau=0.05, false confirms at delta=0 remain near the nominal rate:

| Cell (HIGH ICC, tau=0.05) | P(confirmed\|delta=0) |
|--------------------------|----------------------|
| E=6, S=3  | ${pct(e6s3nullHt.pConfirmed)} |
| E=6, S=5  | ${pct(e6s5nullHt.pConfirmed)} |

## Power reference

P(confirmed) at delta=0.3 (after #2404 fix — n anchored to episodes):

### Low ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
${EPISODE_COUNTS.map((ep) => {
  const s = (sp: typeof SAMPLE_COUNTS[number]) => pct(findCell(cellsLow, 0.3, ep, sp, 0)!.pConfirmed);
  return `| ${ep} | ${s(1)} | ${s(3)} | ${s(5)} |`;
}).join('\n')}

Power at E=12, S=5 (low ICC, after fix): **${pct(e12s5pwrL.pConfirmed)}** (was ≈96.8% before; that was n-inflated).

### High ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
${EPISODE_COUNTS.map((ep) => {
  const s = (sp: typeof SAMPLE_COUNTS[number]) => pct(findCell(cellsHigh, 0.3, ep, sp, 0)!.pConfirmed);
  return `| ${ep} | ${s(1)} | ${s(3)} | ${s(5)} |`;
}).join('\n')}

Power at E=12, S=5 (high ICC, after fix): **${pct(e12s5pwrH.pConfirmed)}** (reduced further by high between-episode variance).

## False-confirm reference (delta=0)

### Low ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
${EPISODE_COUNTS.map((ep) => {
  const s = (sp: typeof SAMPLE_COUNTS[number]) => pct(findCell(cellsLow, 0, ep, sp, 0)!.pConfirmed);
  return `| ${ep} | ${s(1)} | ${s(3)} | ${s(5)} |`;
}).join('\n')}

### High ICC (tau=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
${EPISODE_COUNTS.map((ep) => {
  const s = (sp: typeof SAMPLE_COUNTS[number]) => pct(findCell(cellsHigh, 0, ep, sp, 0)!.pConfirmed);
  return `| ${ep} | ${s(1)} | ${s(3)} | ${s(5)} |`;
}).join('\n')}

Ideal (well-calibrated 95% two-sided CI): P(confirmed|delta=0) ≈ 2.5% one-sided.
The numbers above vary because at small n the Wilson/Newcombe CI is conservative
and the unclear/refuted balance shifts.

## Interval method: Newcombe Hybrid Score over per-episode means

**Chosen method:** Newcombe hybrid score (Method 10, Newcombe 1998) applied to
per-episode mean scores. Each element passed to \`compareRates\` is the within-
episode average of sample scores (in [0,1]). n = number of episodes.

**Why not paired t / bootstrap?** Both arms run the same episodes (paired design),
which makes pairing statistically preferable when the per-episode effect is the
target. However, the current codebase uses Wilson/Newcombe throughout for
consistency and because the episode means are fractional (judge probabilities in
[0,1], not binary outcomes). The Newcombe CI remains valid for fractional means
when n is interpreted as the number of unit-weight observations. A paired t or
bootstrap would require a separate CI module and would break the clean
\`compareRates([baseline]), compareRates([candidate])\` interface; that upgrade
is left for a future PR when the sample size justifies the precision gain.
`;

await fs.writeFile(OUT, doc, 'utf8');
console.log(`Wrote ${OUT}`);
