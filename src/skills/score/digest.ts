/**
 * Telegram digest for `afk farm` run results.
 *
 * Formats a plain-text summary of a completed farm run and optionally pushes
 * it to every configured Telegram chat via `pushIfConfigured`.
 *
 * Inline-button support is explicitly OUT OF SCOPE for v1 — plain text only.
 *
 * @module skills/score/digest
 */

import { rankBranches } from './index.js';
import { buildFarmDigestKeyboard } from './digest-keyboard.js';
import { type FarmRunRecord, type FarmBranchRecord } from './farm-run-record.js';

// Re-export so existing callers (and the test file) can keep importing types
// from this module. Canonical source is `./farm-run-record.ts`.
export type { FarmRunRecord, FarmBranchRecord };

// ---------------------------------------------------------------------------
// formatFarmDigest
// ---------------------------------------------------------------------------

/**
 * Format a plain-text summary of a completed farm run. No Telegram markdown —
 * output is portable across surfaces.
 */
export function formatFarmDigest(record: FarmRunRecord): string {
  const { taskName, taskSlug, baseSha, branches, winner } = record;

  const okBranches = branches.filter((b) => b.ok);
  const failedBranches = branches.filter((b) => !b.ok);
  const total = branches.length;
  const succeeded = okBranches.length;

  // Build rankable list from ok branches only (failed have no score worth ranking).
  const rankable = okBranches.map((b) => ({
    index: b.index,
    score: b.score ?? null,
  }));
  const rankedIndices = rankBranches(rankable);

  // Map index → branch record for quick lookup.
  const byIndex = new Map<number, FarmBranchRecord>(branches.map((b) => [b.index, b]));

  const lines: string[] = [];

  // Header
  lines.push(`🌱 Farm complete: ${succeeded}/${total} branches — ${taskName}`);
  lines.push('');

  // Ranked ok branches
  let displayPos = 1;
  for (const idx of rankedIndices) {
    const b = byIndex.get(idx);
    if (!b) continue;
    const isWinner = winner !== undefined && winner === b.index;
    const label = b.label ? ` (${b.label})` : '';
    const score = b.score ?? null;

    const testIcon = score === null ? '—' : score.pass > 0 ? '✓' : '✗';
    const lintIcon =
      score === null
        ? '—'
        : score.lint_ok === true
          ? '✓'
          : score.lint_ok === false
            ? '✗'
            : '?';

    const locDelta =
      score === null
        ? '?'
        : score.loc_delta > 0
          ? `+${score.loc_delta}`
          : score.loc_delta < 0
            ? `${score.loc_delta}`
            : '0';

    const winnerSuffix = isWinner ? '  ← winner' : '';
    lines.push(
      `#${displayPos} ${b.branch}${label}   tests${testIcon} lint${lintIcon}  ${locDelta} LoC${winnerSuffix}`,
    );
    displayPos++;
  }

  // Failed branches — appear last, sorted by index ascending, with "failed:" prefix
  const sortedFailed = [...failedBranches].sort((a, b) => a.index - b.index);
  for (const b of sortedFailed) {
    const label = b.label ? ` (${b.label})` : '';
    const reason = b.error ?? 'unknown error';
    lines.push(`#${displayPos} ${b.branch}${label}   failed: ${reason}`);
    displayPos++;
  }

  lines.push('');

  // No-winner warning
  if (winner === undefined) {
    lines.push('⚠ no branch won (no successful + scored branches)');
    lines.push('');
  }

  // Footer
  const shortSha = baseSha.slice(0, 7);
  lines.push(`base: ${shortSha}`);
  lines.push(`farm: ~/.afk/farms/${taskSlug}/`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// sendFarmDigest
// ---------------------------------------------------------------------------

/**
 * Format and push the farm digest to Telegram. Never throws — farm completion
 * is more important than digest delivery.
 *
 * @param record  The completed farm run record.
 * @param opts    Injection seam: `_push` replaces `pushIfConfigured` in tests.
 */
export async function sendFarmDigest(
  record: FarmRunRecord,
  opts?: {
    _push?: typeof import('../../telegram/push.js').pushIfConfigured;
  },
): Promise<{ sent: boolean; chatCount?: number; reason?: string }> {
  // Constraint: format before push so a formatting bug surfaces independently
  // of Telegram reachability. The keyboard is attached regardless of whether
  // there's a winner — buttons that are nonsensical without a winner
  // (Open PR / Respawn) are validated by the dispatcher, not hidden here.
  // This keeps the on-the-wire shape identical across runs and gives the
  // user a Discard-all affordance even when every branch failed.
  const text = formatFarmDigest(record);
  const replyMarkup = buildFarmDigestKeyboard(record.taskSlug);

  // Lazy dynamic import keeps push.ts out of the module graph when unused.
  const pushFn: typeof import('../../telegram/push.js').pushIfConfigured =
    opts?._push ??
    (await import('../../telegram/push.js').then((m) => m.pushIfConfigured));

  try {
    const result = await pushFn(text, { replyMarkup });

    if (result === null) {
      return { sent: false, reason: 'telegram unconfigured' };
    }

    return { sent: true, chatCount: result.length };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
