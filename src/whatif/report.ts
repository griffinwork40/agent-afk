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
  Prediction,
  VerifiedPrediction,
  WhatifReport,
} from './types.js';
import { describeChange } from './operators/index.js';
export { buildHeadline } from './report.headline.js';

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
// Verified prediction table (#2403)
// ---------------------------------------------------------------------------

/** "2 probes, n=6/6" : how many episodes and graded outputs back a verdict. */
function scoredOn(vp: VerifiedPrediction): string {
  const n = `n=${vp.rates.n.baseline}/${vp.rates.n.candidate}`;
  if (!vp.scope) return n; // pre-#2403 result: pooled over every episode
  const eps = new Set([...vp.scope.episodes.baseline, ...vp.scope.episodes.candidate]).size;
  if (eps === 0) return `no graded probes (${vp.scope.targetedEpisodes} planned)`;
  return `${eps} probe${eps === 1 ? '' : 's'}, ${n}`;
}

function backgroundStr(vp: VerifiedPrediction): string {
  const bg = vp.scope?.background;
  if (!bg) return '—';
  return `${pct(bg.baseline)} → ${pct(bg.candidate)} (n=${bg.n.baseline}/${bg.n.candidate})`;
}

function episodeList(vp: VerifiedPrediction): string {
  const { baseline, candidate } = vp.scope!.episodes;
  if (baseline.length === 0 && candidate.length === 0) return 'none graded';
  if (baseline.join(',') === candidate.join(',')) return baseline.join(', ');
  return `baseline ${baseline.join(', ') || 'none'}; candidate ${candidate.join(', ') || 'none'}`;
}

/**
 * Verified predictions table plus the per-prediction evidence list.
 *
 * Contract (#2403): Before / After / CI / Result come from the prediction's
 * own probes only. "Other episodes" is the same question on every other
 * episode, shown for context and never part of the verdict. `n` is graded
 * outputs per arm (episodes × samples that survived running and judging).
 */
function renderVerifiedPredictionTable(
  predictions: Prediction[],
  verified: VerifiedPrediction[],
): string[] {
  const lines: string[] = [];
  const vpMap = new Map(verified.map((vp) => [vp.prediction.id, vp]));
  lines.push('> Before / After / CI / Result use only the probes written for each prediction. "Other episodes" is the same question on every other episode, for context; it does not affect the result.\n');
  lines.push('| # | Behavior | Direction | Before | After | CI | Scored on | Other episodes | Result |');
  lines.push('|---|----------|-----------|--------|-------|----|-----------|----------------|--------|');
  for (const pred of predictions) {
    const vp = vpMap.get(pred.id);
    if (!vp) {
      lines.push(`| ${pred.id} | ${pred.behavior} | ${pred.direction} | — | — | — | — | — | ⚪ unclear |`);
      continue;
    }
    lines.push(
      `| ${pred.id} | ${pred.behavior} | ${pred.direction} | ${pct(vp.rates.baseline)} | ${pct(vp.rates.candidate)} | ${ciStr(vp.rates.ci)} | ${scoredOn(vp)} | ${backgroundStr(vp)} | ${verdictEmoji(vp.verdict)} ${vp.verdict} |`,
    );
  }
  const scoped = predictions.map((p) => vpMap.get(p.id)).filter((vp) => vp?.scope !== undefined);
  if (scoped.length > 0) {
    lines.push('', '**Episodes behind each result:**', '');
    for (const vp of scoped) lines.push(`- ${vp!.prediction.id}: ${episodeList(vp!)}`);
  }
  return lines;
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
          `  ${palette.meta(`${pct(vp.rates.baseline)} → ${pct(vp.rates.candidate)} (${scoredOn(vp)})`)}` +
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
