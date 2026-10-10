/**
 * Per-round "[vitals]" harness note: live-state awareness for the model.
 *
 * The model only perceives the world at request boundaries, so "constant
 * awareness" of a moving quantity means a fresh reading in every request. This
 * module renders one short line per tool round, e.g.
 *
 *   [vitals] Fri 2026-10-09 14:32 EDT · turn 4m12s · context 61% · Claude 5h usage 84%, full in ~48m
 *
 * Invariant: placement. Both providers append the note at the END of the
 * newest tool-result turn, which is the uncached tail of the request, and never
 * edit it afterwards. anthropic-direct adds it as a sibling text block in the
 * tool_result user turn (outside any tool_result content); openai-compatible
 * appends it to the round's last `role:'tool'` message, because there a
 * separate `role:'user'` message would be a compaction boundary and a /rewind
 * target (see dispatch-append.ts). It must never go in the system prompt (any
 * change there invalidates the prompt cache for the whole conversation, see
 * shared/date-rollover.ts), and never through `beforeNextRound` (a single slot
 * owned by subagent steering and peer delivery, whose separate user turn
 * compaction treats as human input). The note carries no authority, so a tool
 * printing a lookalike line can at worst mislead the model about the time.
 *
 * Contract: two tiers, both stateless so a replayed or resumed note is never
 * misread as current:
 *   - Ambient, every round: absolute local time with zone (self-dating on
 *     resume), elapsed turn time, and time left before the soft deadline when
 *     one is set.
 *   - Salience, only when it matters: context fill once it reaches
 *     {@link CONTEXT_SHOW_PCT}, Claude subscription usage once it reaches
 *     {@link USAGE_SHOW_PCT} (root sessions only; a subagent cannot act on the
 *     account window). Either is tagged `(high)` at {@link HIGH_PCT}.
 *   Absence of a field means "fine", so the model is not nudged toward
 *   quitting early by numbers that do not need attention.
 *
 * Contract: {@link buildVitalsNote} never throws. Every source is optional and
 * every failure degrades to omitting a field (or the whole note), because this
 * runs inside the tool loop where a throw would orphan a `tool_use` round.
 *
 * @module agent/providers/shared/vitals
 */

import { env, isExplicitlyDisabled } from '../../../config/env.js';
import { contextLimitFor } from '../../model-limits.js';
import { readUsageRecord, ANTHROPIC_OAUTH } from '../../usage/usage-snapshot.js';
import { bindingWindow, isStale } from '../../usage/usage-budget.js';
import { computeBurnRate } from '../../usage/burn-rate.js';
import type { UsageRecord } from '../../usage/usage-record.js';
import { formatClock } from '../../awareness/index.js';

/** Prefix every vitals note starts with. Tests and readers key on it. */
export const VITALS_PREFIX = '[vitals]';

/** Context fill (percent) at which the context field starts appearing. */
export const CONTEXT_SHOW_PCT = 50;
/** Subscription usage (percent) at which the usage field starts appearing. */
export const USAGE_SHOW_PCT = 80;
/** Percent at which a shown field is tagged `(high)`. */
export const HIGH_PCT = 90;

/** How long one usage-ledger read is reused. The read is synchronous SQLite. */
export const USAGE_CACHE_TTL_MS = 60_000;

/** Per-round inputs, all optional except the turn origin. */
export interface VitalsInput {
  /** Epoch ms the user turn started (the soft-deadline origin). */
  readonly turnStartedAt: number;
  /** Soft wall-clock deadline in ms from turn start. `0`/unset = none. */
  readonly softDeadlineMs?: number | undefined;
  /** Latest round's full context-window occupancy in tokens. */
  readonly contextTokens?: number | undefined;
  /** Model id, used to resolve the context-window limit. */
  readonly model?: string | undefined;
  /** Set for forked children: suppresses the account-level usage field. */
  readonly subagentId?: string | undefined;
  /** Whether the Claude subscription windows apply to this session. */
  readonly claudeUsage?: boolean | undefined;
}

/** Injectable dependencies so the builder is deterministic under test. */
export interface VitalsDeps {
  readonly now?: () => number;
  /** IANA zone override; defaults to the host zone. */
  readonly timeZone?: string;
  readonly readClaudeUsage?: () => UsageRecord | undefined;
  readonly contextLimit?: (model: string) => number;
}

/** True unless `AFK_VITALS` is explicitly disabled. Single env read-point. */
export function vitalsEnabled(): boolean {
  return !isExplicitlyDisabled(env.AFK_VITALS ?? '');
}

/**
 * Build the note for one round, or `undefined` when disabled or on any error.
 */
export function buildVitalsNote(input: VitalsInput, deps: VitalsDeps = {}): string | undefined {
  try {
    if (!vitalsEnabled()) return undefined;
    const now = (deps.now ?? Date.now)();
    const parts: string[] = [formatClock(now, deps.timeZone), `turn ${formatDuration(now - input.turnStartedAt)}`];

    const deadline = input.softDeadlineMs ?? 0;
    if (deadline > 0) {
      const left = deadline - (now - input.turnStartedAt);
      parts.push(left > 0 ? `wind-down in ${formatDuration(left)}` : 'wind-down due');
    }

    const context = contextField(input, deps);
    if (context !== undefined) parts.push(context);

    if (input.subagentId === undefined && input.claudeUsage === true) {
      const usage = usageField((deps.readClaudeUsage ?? readClaudeUsageCached)(), now);
      if (usage !== undefined) parts.push(usage);
    }
    return `${VITALS_PREFIX} ${parts.join(' · ')}`;
  } catch {
    return undefined;
  }
}

function contextField(input: VitalsInput, deps: VitalsDeps): string | undefined {
  const used = input.contextTokens;
  if (used === undefined || used <= 0 || input.model === undefined) return undefined;
  const limit = (deps.contextLimit ?? contextLimitFor)(input.model);
  if (!(limit > 0)) return undefined;
  const pct = Math.round((used / limit) * 100);
  if (pct < CONTEXT_SHOW_PCT) return undefined;
  return `context ${pct}%${pct >= HIGH_PCT ? ' (high)' : ''}`;
}

function usageField(rec: UsageRecord | undefined, now: number): string | undefined {
  const windows = rec?.windows;
  if (windows === undefined || isStale(windows.observedAt, now)) return undefined;
  const binding = bindingWindow(windows);
  if (binding === undefined || binding.pct < USAGE_SHOW_PCT) return undefined;
  let text = `Claude ${binding.label} usage ${binding.pct}%${binding.pct >= HIGH_PCT ? ' (high)' : ''}`;
  const burn = computeBurnRate(windows.history ?? [], now, binding.resetsAt);
  if (burn !== null && burn.capsAtMs > now) {
    text += `, full in ~${formatDuration(burn.capsAtMs - now, false)}`;
  } else if (binding.resetsAt !== undefined && binding.resetsAt > now) {
    text += `, resets in ${formatDuration(binding.resetsAt - now, false)}`;
  }
  return text;
}

let usageCache: { at: number; rec: UsageRecord | undefined } | undefined;

/** Ledger read reused for {@link USAGE_CACHE_TTL_MS}; never touches the network. */
function readClaudeUsageCached(): UsageRecord | undefined {
  const now = Date.now();
  if (usageCache !== undefined && now - usageCache.at < USAGE_CACHE_TTL_MS) return usageCache.rec;
  const rec = readUsageRecord(ANTHROPIC_OAUTH.provider, ANTHROPIC_OAUTH.account);
  usageCache = { at: now, rec };
  return rec;
}

/** Test seam: drop the memoized ledger read. */
export function resetVitalsUsageCacheForTests(): void {
  usageCache = undefined;
}

/**
 * Compact duration: `42s`, `4m12s`, `1h05m`. With `seconds=false` minutes are
 * the finest unit (`48m`, `2h10m`), for coarse forecasts.
 */
export function formatDuration(ms: number, seconds = true): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (!seconds) return `${Math.max(1, m)}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
