/**
 * Report rendering for the what-if prediction engine.
 *
 * Three render targets:
 *   - {@link buildHeadline}   — one plain-English sentence.
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
  Prediction,
  VerifiedPrediction,
  WhatifReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function ciStr(ci: [number, number]): string {
  return `[${pct(ci[0])}, ${pct(ci[1])}]`;
}

function verdictEmoji(v: 'confirmed' | 'refuted' | 'unclear'): string {
  if (v === 'confirmed') return '✅';
  if (v === 'refuted') return '❌';
  return '⚪';
}

/** Truncate a string to at most `maxLines` lines, appending a note if cut. */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines truncated)`;
}

// ---------------------------------------------------------------------------
// buildHeadline
// ---------------------------------------------------------------------------

/**
 * Build a single plain-English sentence summarising the report.
 *
 * For predict-only runs it describes the top prediction (if any).
 * For verified runs it includes the most notable rate shift and the
 * prediction accuracy.
 */
export function buildHeadline(report: Omit<WhatifReport, 'headline'>): string {
  const { predictions, verify } = report;

  if (!verify) {
    // Predict-only.
    const first = predictions[0];
    if (!first) return 'No behavioral changes predicted.';
    return `Predicted (not yet measured): ${first.behavior} is expected to be ${first.direction} (${first.confidence} confidence).`;
  }

  // Verified run — find the largest |delta| among verified predictions.
  const { predictions: verified, features, predictionAccuracy } = verify;

  // Look at VerifiedPredictions then feature deltas for the biggest shift.
  let biggestLabel = '';
  let biggestDelta = 0;
  let biggestBefore = 0;
  let biggestAfter = 0;

  for (const vp of verified) {
    const d = Math.abs(vp.rates.delta);
    if (d > biggestDelta) {
      biggestDelta = d;
      biggestLabel = (vp.prediction as Prediction).behavior;
      biggestBefore = vp.rates.baseline;
      biggestAfter = vp.rates.candidate;
    }
  }

  for (const feat of features) {
    const d = Math.abs(feat.rates.delta);
    if (d > biggestDelta) {
      biggestDelta = d;
      biggestLabel = feat.label.toLowerCase();
      biggestBefore = feat.rates.baseline;
      biggestAfter = feat.rates.candidate;
    }
  }

  const totalResolved = verified.filter(
    (vp) => vp.verdict === 'confirmed' || vp.verdict === 'refuted',
  ).length;
  const confirmed = verified.filter((vp) => vp.verdict === 'confirmed').length;

  const accStr =
    predictionAccuracy !== undefined
      ? `; ${confirmed} of ${totalResolved} predictions confirmed`
      : '';

  if (!biggestLabel) {
    return `No significant behavioral differences detected${accStr}.`;
  }

  return `Likely effect: ${biggestLabel} much ${biggestAfter > biggestBefore ? 'more' : 'less'} often (${pct(biggestBefore)} → ${pct(biggestAfter)})${accStr}.`;
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
    const vpMap = new Map(
      verify.predictions.map((vp) => [vp.prediction.id, vp]),
    );
    lines.push('| # | Behavior | Direction | Before | After | CI | Result |');
    lines.push('|---|----------|-----------|--------|-------|----|--------|');
    for (const pred of predictions) {
      const vp = vpMap.get(pred.id);
      if (!vp) {
        lines.push(`| ${pred.id} | ${pred.behavior} | ${pred.direction} | — | — | — | ⚪ unclear |`);
        continue;
      }
      lines.push(
        `| ${pred.id} | ${pred.behavior} | ${pred.direction} | ${pct(vp.rates.baseline)} | ${pct(vp.rates.candidate)} | ${ciStr(vp.rates.ci)} | ${verdictEmoji(vp.verdict)} ${vp.verdict} |`,
      );
    }
  }
  lines.push('');

  if (verify) {
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

/** One-liner for a Change (used in report). */
function describeChange(ch: { kind: string; [k: string]: unknown }): string {
  switch (ch.kind) {
    case 'append':
      return `Append text to ${String(ch['target'])}.`;
    case 'file':
      return `Replace file at ${String(ch['path'])}.`;
    case 'hot':
      return `Replace HOT.md memory.`;
    case 'memory-add':
      return `Add memory: "${String(ch['content']).slice(0, 80)}".`;
    case 'memory-remove':
      return `Remove memory #${String(ch['id'])}.`;
    case 'disable-skill':
      return `Disable skill: ${String(ch['name'])}.`;
    case 'disable-plugin':
      return `Disable plugin: ${String(ch['name'])}.`;
    case 'model':
      return `Change model to ${String(ch['model'])}.`;
    case 'effort':
      return `Change effort to ${String(ch['effort'])}.`;
    case 'env':
      return `Set env var ${String(ch['key'])}.`;
    default:
      return `Change kind: ${ch.kind}.`;
  }
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
          `  ${palette.meta(`${pct(vp.rates.baseline)} → ${pct(vp.rates.candidate)}` )}` +
          `  ${verdictColor(vp.verdict)}`,
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
 */
export function standardLimits(opts: { verified: boolean; judgeExternal: boolean }): string[] {
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

  return limits;
}
