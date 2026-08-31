/**
 * Turn-footer rendering helpers extracted from turn-handler.ts to keep that
 * file within the 350-line baseline ceiling.
 *
 * Contains the context-usage escalation logic (`formatContextUsage` /
 * `ContextTier`) and the per-turn stats footer printer (`printTurnFooter`).
 * Both are pure-ish utilities: `printTurnFooter` calls live quota accessors
 * but is otherwise state-free and unit-testable with a mock writer.
 *
 * @module cli/commands/interactive/turn-handler.footer
 */

import type { SessionStats } from '../../slash/types.js';
import { palette } from '../../palette.js';
import { formatDuration, formatCost, formatTokens } from '../../format-utils.js';
import { contextLimitFor } from '../../model-limits.js';
import { getQuotaSnapshot } from '../../../agent/quota-cache.js';
import { quotaWindowsFromSnapshot } from '../../quota-indicator.js';
import { formatQuotaUsage } from '../../quota-footer.js';
import { contextRatio } from './shared.js';
import { resolveAutoResumeOnUsageLimit } from '../../config.js';

export type ContextTier = 'quiet' | 'normal' | 'caution' | 'near' | 'over';

// Contract: maps a context-window usage ratio to an escalating footer line +
// tier so the REPL warns *proactively* as a session approaches the model's
// limit, not only once truncation is already happening. `text` is null for the
// quiet tier (<=50% — no line, keeps short sessions uncluttered). The caller
// maps tier -> palette color: over/near -> error, caution -> warning,
// normal -> dim. Pure and color-free so it is unit-testable without a palette
// or terminal. Thresholds are intentionally hardcoded (not config): 80% =
// approaching, 95% = near, 100%+ = over.
export function formatContextUsage(
  contextPct: number,
  contextLimit: number,
): { tier: ContextTier; text: string | null } {
  const pct = Math.round(contextPct * 100);
  const limitStr = formatTokens(contextLimit);
  if (contextPct >= 1.0) {
    const overByTok = Math.round((contextPct - 1.0) * contextLimit);
    const limitK = Math.round(contextLimit / 1000);
    return {
      tier: 'over',
      text: `  context OVER ${limitK}k tokens by ~${formatTokens(overByTok)} tokens — model output may be silently truncated`,
    };
  }
  if (contextPct >= 0.95) {
    return {
      tier: 'near',
      text: `  context ${pct}% used of ${limitStr} — near limit; output may soon truncate (consider /clear or a fresh session)`,
    };
  }
  if (contextPct >= 0.8) {
    return { tier: 'caution', text: `  context ${pct}% used of ${limitStr} — approaching limit` };
  }
  if (contextPct > 0.5) {
    return { tier: 'normal', text: `  context ${pct}% used of ${limitStr}` };
  }
  return { tier: 'quiet', text: null };
}

export function printTurnFooter(
  meta: { durationMs?: number; totalCostUsd?: number; usage?: Record<string, unknown> } | undefined,
  stats: SessionStats,
  // Optional compositor-aware writer (Stage 3e). When `runTurn` calls
  // this between `disposeRendererOnce()` and the finally block, the
  // borrowed compositor is still armed — a raw `console.log` would
  // corrupt log-update's line tracker and strand the verdict/footer
  // above the live overlay. Defaults to console.log for direct callers
  // that don't have a compositor lifecycle (tests, standalone).
  write: (line: string) => void = console.log,
): void {
  if (!meta) return;
  const parts: string[] = [];
  if (meta.durationMs) parts.push(formatDuration(meta.durationMs));
  if (meta.totalCostUsd !== undefined) parts.push(formatCost(meta.totalCostUsd));
  const inTok = Number(meta.usage?.['input_tokens'] ?? 0);
  const outTok = Number(meta.usage?.['output_tokens'] ?? 0);
  if (inTok + outTok > 0) parts.push(formatTokens(inTok + outTok) + ' tokens');
  if (parts.length > 0) {
    write(palette.dim('  ◦ ' + parts.join('  ·  ')));
  }
  const contextPct = contextRatio(stats);
  const contextLimit = contextLimitFor(stats.model);
  const usage = formatContextUsage(contextPct, contextLimit);
  if (usage.text !== null) {
    // Escalation is by severity/color, not by suppression: the footer already
    // renders once per turn, so a single tier-colored line per turn is the
    // expected cadence (no cross-turn tier tracking needed).
    const colorFn =
      usage.tier === 'over' || usage.tier === 'near'
        ? palette.error
        : usage.tier === 'caution'
          ? palette.warning
          : palette.dim;
    write(colorFn(usage.text));
  }
  // Subscription quota, same cadence and tone mapping as the context line above.
  // Ordered AFTER it deliberately: context is the constraint on THIS turn, quota
  // is the constraint on the next hour — nearest deadline reads first. Silent
  // below 80% (the status-line indicator covers that range ambiently) and silent
  // forever under API-key auth, where the quota headers never arrive.
  // The park-and-resume promise is conditional on the real retry configuration
  // (see capNote, quota-footer.ts), so the flag is read rather than assumed.
  // Via the memoized-tier resolver, NOT loadConfig(): the latter re-installs
  // process-global slot bindings on every call, disqualifying it for a
  // per-turn display read.
  const quota = formatQuotaUsage(quotaWindowsFromSnapshot(getQuotaSnapshot()), new Date(), {
    autoResume: resolveAutoResumeOnUsageLimit(),
  });
  if (quota.text !== null) {
    const quotaColorFn =
      quota.tier === 'over' || quota.tier === 'near'
        ? palette.error
        : quota.tier === 'caution'
          ? palette.warning
          : palette.dim;
    write(quotaColorFn(quota.text));
  }
  write('');
}
