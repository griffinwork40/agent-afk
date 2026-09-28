/**
 * Report rendering for the what-if prediction engine.
 *
 * Three render targets:
 *   - {@link buildHeadline}   — one plain-English sentence (see report.headline.ts).
 *   - {@link renderMarkdown}  — full GitHub-flavoured Markdown report.
 *   - {@link renderTerminal}  — compact terminal output using the semantic palette.
 *   - {@link standardLimits} — caveats that accompany every report.
 *
 * No model calls. No I/O.
 *
 * @module whatif/report
 */

import type { ThemePalette } from '../cli/palette.js';
import type {
  VerifiedPrediction,
  WhatifReport,
} from './types.js';
import { fmtP, renderProbeSignFlipSection } from './report.signflip.js';
import { scoredOn, renderVerifiedPredictionTable } from './report.predictions.js';
import { describeChange } from './operators/index.js';
import { verdictEmoji, verdictLabel } from './report-verdict.js';
import { mdeLimitLine } from './mde.js';
export { buildHeadline } from './report.headline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Truncate a string to at most `maxLines` lines, appending a note if cut. */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines truncated)`;
}

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

/**
 * Render a full Markdown report.
 *
 * Sections:
 * 1. Headline
 * 2. What changed (change descriptions)
 * 3. Structural impact (tools, token delta, cost, model, system diff in `<details>`)
 * 4. Predictions table
 * 5. Unexpected differences (discover, verify only)
 * 6. Measured behaviors (feature deltas, verify only)
 * 7. Judge line
 * 8. Limits
 * 9. Cost + run folder
 */
export function renderMarkdown(report: WhatifReport): string {
  const { spec, structural, predictions, verify, costUsd, runDir, limits, headline } = report;
  const lines: string[] = [];

  // ── 1. Headline ─────────────────────────────────────────────────────────
  lines.push(`# What-If Report\n`);
  lines.push(`${headline}\n`);

  // ── 2. What changed ──────────────────────────────────────────────────────
  lines.push(`## What Changed\n`);
  lines.push(`**${spec.title}**\n`);
  for (const ch of spec.changes) {
    lines.push(`- ${describeChange(ch)}`);
  }
  lines.push('');

  // ── 3. Structural impact ─────────────────────────────────────────────────
  lines.push(`## Structural Impact\n`);

  if (structural.modelChanged) {
    lines.push(`**Model:** ${structural.baseline.model} → ${structural.candidate.model}\n`);
  }

  const tokenDelta = structural.tokens.candidate - structural.tokens.baseline;
  const tokenSign = tokenDelta >= 0 ? '+' : '';
  lines.push(`**System tokens:** ${structural.tokens.baseline.toLocaleString()} → ${structural.tokens.candidate.toLocaleString()} (${tokenSign}${tokenDelta.toLocaleString()})\n`);

  if (structural.perTurnCostDeltaUsd !== undefined) {
    const cents = (structural.perTurnCostDeltaUsd * 100).toFixed(3);
    const sign = structural.perTurnCostDeltaUsd >= 0 ? '+' : '';
    lines.push(`**Per-turn cost delta:** ${sign}${cents}¢\n`);
  }

  if (structural.toolsAdded.length > 0) {
    lines.push(`**Tools added:** ${structural.toolsAdded.join(', ')}\n`);
  }
  if (structural.toolsRemoved.length > 0) {
    lines.push(`**Tools removed:** ${structural.toolsRemoved.join(', ')}\n`);
  }
  if (structural.toolsChanged.length > 0) {
    lines.push(`**Tools changed:** ${structural.toolsChanged.join(', ')}\n`);
  }

  if (structural.systemDiff) {
    const truncated = truncateLines(structural.systemDiff, 200);
    lines.push(`<details><summary>System prompt diff</summary>\n\n\`\`\`diff\n${truncated}\n\`\`\`\n</details>\n`);
  }

  // ── 4. Predictions table ─────────────────────────────────────────────────
  lines.push(`## Predictions\n`);

  if (!verify) {
    // Predict-only: label as guesses.
    lines.push('> These are guesses until verified (run with `--verify`).\n');
    lines.push('| # | Behavior | Direction | Confidence | Reason |');
    lines.push('|---|----------|-----------|------------|--------|');
    for (const pred of predictions) {
      lines.push(
        `| ${pred.id} | ${pred.behavior} | ${pred.direction} | ${pred.confidence} | ${pred.reason} |`,
      );
    }
  } else {
    lines.push(...renderVerifiedPredictionTable(predictions, verify.predictions));
  }
  lines.push('');

  if (verify) {
    // ── 4.5. Arm imbalance warning + failed episodes (#2411) ──────────────
    if (verify.armImbalance) {
      lines.push(`> [!WARNING]`);
      lines.push(`> **${verify.armImbalance.summary}**`);
      lines.push('');
    }

    const recs = verify.failedEpisodeRecords ?? [];
    if (recs.length > 0) {
      lines.push(`## Failed Episodes\n`);
      lines.push('| Episode | Arm | Sample | Class | Duration | Message |');
      lines.push('|---------|-----|--------|-------|----------|---------|');
      for (const r of recs) {
        const probeCell = r.probe ? ` (${r.probe})` : '';
        lines.push(
          `| ${r.episodeId}${probeCell} | ${r.arm} | ${r.sample} | ${r.errorClass} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.errorMessage} |`,
        );
      }
      lines.push('');
    }

    // ── 4b. Paired per-probe sign-flip (secondary, additive) ─────────────
    const sfLines = renderProbeSignFlipSection(verify.predictions, verify.armImbalance);
    if (sfLines.length > 0) {
      lines.push(...sfLines);
      lines.push('');
    }

    // ── 5. Unexpected differences ─────────────────────────────────────────
    if (verify.discovered.length > 0) {
      lines.push(`## Unexpected Differences\n`);
      lines.push('| Description | Before | After |');
      lines.push('|-------------|--------|-------|');
      for (const d of verify.discovered) {
        lines.push(
          `| ${d.description} | ${pct(d.rates.baseline)} | ${pct(d.rates.candidate)} |`,
        );
      }
      lines.push('');
    }

    // ── 6. Measured behaviors ─────────────────────────────────────────────
    if (verify.features.length > 0) {
      lines.push(`## Measured Behaviors\n`);
      lines.push('| Feature | Before | After | Delta |');
      lines.push('|---------|--------|-------|-------|');
      for (const feat of verify.features) {
        const d = feat.rates.delta;
        const sign = d >= 0 ? '+' : '';
        lines.push(
          `| ${feat.label} | ${pct(feat.rates.baseline)} | ${pct(feat.rates.candidate)} | ${sign}${pct(d)} |`,
        );
      }
      lines.push('');
    }

    // ── 7. Judge ──────────────────────────────────────────────────────────
    lines.push(`## Judge\n`);
    const judgeDesc = verify.judge.external
      ? `Graded by ${verify.judge.name} (external service).`
      : `Graded by ${verify.judge.name}.`;
    const crossCheck =
      verify.judge.crossCheckAgreement !== undefined
        ? ` Claude cross-check agreement: ${pct(verify.judge.crossCheckAgreement)}.`
        : '';
    lines.push(`${judgeDesc}${crossCheck}\n`);
    lines.push(
      'The cross-check re-grades a ~10% sample of outputs with a second judge model; per-prediction agreement is shown in the "Judge agree" column and, when fewer than 5 items were sampled, flagged as "too few cross-checks". A confirmed or refuted verdict is automatically downgraded to unclear when per-prediction agreement is below 75% (judges disagree).\n',
    );
  }

  // ── 8. Limits ────────────────────────────────────────────────────────────
  lines.push(`## Limits\n`);
  for (const l of limits) {
    lines.push(`- ${l}`);
  }
  lines.push('');

  // ── 9. Cost + run folder ─────────────────────────────────────────────────
  lines.push(`## Cost and Run\n`);
  lines.push(`Total cost: $${costUsd.toFixed(4)}\n`);
  lines.push(`Run folder: \`${runDir}\`\n`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderTerminal
// ---------------------------------------------------------------------------

/**
 * Compact terminal rendering using the semantic palette.
 *
 * Returns an array of lines ready to print. Palette members are accessed at
 * render time per the `palette.<role>` at-call-site convention.
 */
export function renderTerminal(report: WhatifReport, palette: ThemePalette): string[] {
  const { headline, predictions, verify, costUsd, limits } = report;
  const out: string[] = [];

  // Arm-imbalance banner — shown before everything else so it cannot be missed.
  if (verify?.armImbalance) {
    out.push(palette.warning(`⚠ ${verify.armImbalance.summary}`));
    out.push('');
  }

  // Headline.
  out.push(palette.brand(headline));
  out.push('');

  // Predictions.
  if (verify) {
    const vpMap = new Map(
      verify.predictions.map((vp: VerifiedPrediction) => [vp.prediction.id, vp]),
    );
    out.push(palette.heading('Predictions'));
    for (const pred of predictions) {
      const vp = vpMap.get(pred.id);
      if (!vp) {
        out.push(`  ${palette.dim(pred.id)} ${pred.behavior} ${palette.meta('unclear')}`);
        continue;
      }
      const verdictColor =
        vp.verdict === 'confirmed'
          ? palette.success
          : vp.verdict === 'refuted'
          ? palette.error
          : palette.meta;
      out.push(
        `  ${palette.dim(pred.id)} ${pred.behavior}` +
          `  ${palette.meta(`${pct(vp.rates.baseline)} → ${pct(vp.rates.candidate)} (${scoredOn(vp)})`)}` +
          `  ${verdictEmoji(vp.verdict)} ${verdictColor(verdictLabel(vp))}`,
      );
    }
  } else {
    out.push(palette.heading('Predictions (not yet measured)'));
    for (const pred of predictions) {
      out.push(
        `  ${palette.dim(pred.id)} ${pred.behavior}  ${palette.meta(`${pred.direction} (${pred.confidence})`)}`,
      );
    }
  }

  out.push('');

  // Paired sign-flip summary (secondary, shown when data exists).
  if (verify) {
    const withSf = verify.predictions.filter(
      (vp: VerifiedPrediction) => vp.probeSignFlip?.p !== null && vp.probeSignFlip !== undefined,
    );
    if (withSf.length > 0) {
      out.push(palette.heading('Per-Probe Paired Analysis (secondary)'));
      for (const vp of withSf) {
        const sf = vp.probeSignFlip!;
        const pStr = sf.p !== null ? `p=${fmtP(sf.p)}` : 'no data';
        const minStr = sf.minAchievableP !== null ? ` (min achievable ${fmtP(sf.minAchievableP)})` : '';
        const warn = sf.underpoweredForSig ? ` ${palette.meta('cannot reach p<0.05')}` : '';
        out.push(
          `  ${palette.dim(vp.prediction.id)} n_paired=${sf.nPaired} n_nonzero=${sf.nNonzero} ` +
          `Δ̄=${sf.meanDelta >= 0 ? '+' : ''}${(sf.meanDelta * 100).toFixed(1)}pp ` +
          `${pStr}${minStr}${warn}`,
        );
      }
      out.push('');
    }
  }

  // Limits.
  out.push(palette.heading('Limits'));
  for (const l of limits) {
    out.push(`  ${palette.dim('•')} ${l}`);
  }

  out.push('');
  out.push(palette.meta(`Total cost: $${costUsd.toFixed(4)}`));

  return out;
}

// ---------------------------------------------------------------------------
// standardLimits
// ---------------------------------------------------------------------------

/**
 * Standard caveats that accompany every what-if report.
 *
 * When `verifiedPredictions` is supplied (verify runs only), an MDE limit
 * bullet is added for each prediction whose achieved MDE exceeds 10 pp.
 */
export function standardLimits(opts: {
  verified: boolean;
  judgeExternal: boolean;
  verifiedPredictions?: VerifiedPrediction[];
}): string[] {
  const limits: string[] = [
    'Episodes stop at the first action with side effects, so this shows what the agent decides, not downstream results.',
  ];

  if (opts.verified) {
    limits.push(
      'Past requests had injected context stripped; per-message hook text was not regenerated.',
    );
  }

  if (!opts.verified) {
    limits.push('Predictions are guesses until verified (run with --verify).');
  }

  if (opts.judgeExternal) {
    limits.push(
      'The external judge (Jev) received redacted episode content. Use --judge claude to keep data on Anthropic.',
    );
  }

  // Per-prediction MDE limit: shown when MDE > 10pp (i.e. small effects are undetectable).
  if (opts.verifiedPredictions) {
    for (const vp of opts.verifiedPredictions) {
      const n = Math.min(vp.rates.n.baseline, vp.rates.n.candidate);
      const line = mdeLimitLine(n, vp.prediction.id);
      if (line) limits.push(line);
    }
  }

  return limits;
}
