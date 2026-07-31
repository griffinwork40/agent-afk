/**
 * Subscription-quota indicator for the status line.
 *
 * Renders the Anthropic OAuth rolling-window utilization (`5h` / `7d`) as a
 * severity-graded, self-explaining segment instead of two flat percentages.
 *
 * Design rationale — a bare percentage is not actionable. `5h 94%` reads
 * identically to `5h 24%` in flat `chrome`, so the single most consequential
 * number on the row ("am I about to get rate-limited?") had the same salience
 * as the token counter, and was the FIRST field shed on a narrow terminal.
 * Three mechanics fix that, all width-cheap:
 *
 *   1. Per-window severity tone. Tiers mirror the context bar exactly
 *      (`> 0.8` error, `> 0.5` warning, else chrome) so the two usage readouts
 *      on the row grade alike.
 *   2. A reset countdown (`⟳12m`) on the BINDING window once it crosses caution.
 *      `94% resets in 12m` and `94% resets in 4h` are opposite situations that
 *      the old segment rendered identically. Only the binding window gets one,
 *      capping the width growth at a few cells.
 *   3. A `stale` flag (see {@link STALE_AFTER_MS}) so the caller can decline to
 *      promote an old reading, and a `~` marker so a long idle session doesn't
 *      show a stale number as live.
 *
 * Invariant: the ladder must stay legible with color stripped, and mechanic 2 is
 * what carries it — the countdown is absent while calm and present from caution
 * up, so `5h 40%` and `5h 69% ⟳2h13m` differ in plain text, and past 80% the
 * turn footer (`quota-footer.ts`) prints the escalation as a sentence. No glyph
 * badge is used for this. An earlier revision prefixed each percentage with a
 * one-cell block gauge (`▁`..`█`) and it looked broken: one cell cannot encode
 * magnitude (the sparkline those glyphs come from reads as a curve only because
 * it has many cells to compare against), so the top of the ramp rendered as a
 * solid block of color abutting the digits — terminal vocabulary for a cursor or
 * a selection, i.e. an artifact — and the bottom as an underscore stub, `▁9%`
 * reading as `_9%`. It also restated, less precisely, the exact number one cell
 * to its right. Severity banding is tone's job; the number is the magnitude.
 *
 * Pure and clock-injectable: takes plain numbers/Dates rather than the
 * `QuotaSnapshot` type, keeping the render layer decoupled from
 * `agent/quota-cache` exactly as `formatContextBar` is decoupled from the
 * session stats.
 *
 * @module cli/quota-indicator
 */

import { palette } from './palette.js';
import type { QuotaSnapshot } from '../agent/quota-cache.js';

/** One rolling window's state, as observed from the response headers. */
export interface QuotaWindowState {
  /** Fraction of the window consumed, `0..1` (already clamped by the cache). */
  readonly utilization: number;
  /** When the window rolls over, if the header carried a parseable deadline. */
  readonly resetsAt?: Date;
}

/** Both rolling windows plus the observation timestamp, for staleness. */
export interface QuotaWindows {
  readonly fiveHour?: QuotaWindowState;
  readonly sevenDay?: QuotaWindowState;
  /** When these values were read off a response. Drives {@link QuotaIndicator.stale}. */
  readonly observedAt?: Date;
}

/**
 * Re-shape a cached {@link QuotaSnapshot} into render input, or `undefined` when
 * neither window is known — the permanent state under API-key auth, where the
 * caller must draw no segment at all rather than a placeholder.
 *
 * Contract: a pure field re-shape, NOT a formatter. `resetsAt`/`observedAt` are
 * forwarded verbatim and every clock comparison stays inside
 * {@link formatQuotaIndicator}, so the status line renders and grades
 * droppability from one severity computed in one place.
 */
export function quotaWindowsFromSnapshot(snapshot: QuotaSnapshot | undefined): QuotaWindows | undefined {
  if (snapshot === undefined) return undefined;
  if (snapshot.fiveHourUtilization === undefined && snapshot.sevenDayUtilization === undefined) {
    return undefined;
  }
  return {
    ...(snapshot.fiveHourUtilization !== undefined
      ? {
          fiveHour: {
            utilization: snapshot.fiveHourUtilization,
            ...(snapshot.fiveHourResetsAt !== undefined ? { resetsAt: snapshot.fiveHourResetsAt } : {}),
          },
        }
      : {}),
    ...(snapshot.sevenDayUtilization !== undefined
      ? {
          sevenDay: {
            utilization: snapshot.sevenDayUtilization,
            ...(snapshot.sevenDayResetsAt !== undefined ? { resetsAt: snapshot.sevenDayResetsAt } : {}),
          },
        }
      : {}),
    observedAt: snapshot.observedAt,
  };
}

/**
 * Worst-window severity. `calm` recedes, `caution` warns, `critical` demands
 * attention — and earns drop-last treatment from the status line.
 */
export type QuotaSeverity = 'calm' | 'caution' | 'critical';

export interface QuotaIndicator {
  /** ANSI-colored segment text, e.g. `5h 94% ⟳12m · 7d 24%`. */
  readonly text: string;
  /** Max severity across the present windows. */
  readonly severity: QuotaSeverity;
  /** True when the underlying observation is older than {@link STALE_AFTER_MS}. */
  readonly stale: boolean;
}

/**
 * Utilization above which a window is `caution`, and above which it is
 * `critical`. Deliberately identical to the context bar's tone thresholds
 * (`context-bar.ts`) so both usage readouts on the status row escalate in step;
 * change them together or the row stops reading as one instrument.
 */
const CAUTION_ABOVE = 0.5;
const CRITICAL_ABOVE = 0.8;

/**
 * A quota reading older than this is marked `~` and reported `stale`.
 *
 * The headers only refresh when a turn hits the API, so an idle session holds
 * its last reading indefinitely. Staleness is never *dangerous* here — a
 * rolling window only decays while idle, so an old reading over-reports rather
 * than under-reports — but an hour-old `94%` that has actually drained to 40%
 * would keep the row alarmed for no reason, so it is marked rather than
 * silently trusted.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** Prefixes the reset countdown. Recessive tone: it is context for the number, not the signal. */
const RESET_GLYPH = '⟳';

function severityOf(utilization: number): QuotaSeverity {
  if (utilization > CRITICAL_ABOVE) return 'critical';
  if (utilization > CAUTION_ABOVE) return 'caution';
  return 'calm';
}

function toneFor(severity: QuotaSeverity) {
  if (severity === 'critical') return palette.error;
  if (severity === 'caution') return palette.warning;
  // Calm stays `chrome`, not `meta`: a fully recessive readout reads as broken
  // rather than reassuring — the same mistake the context bar's single-tone
  // wrap made before it split fill from track.
  return palette.chrome;
}

/**
 * Compact "time remaining" for a status row: `<1m`, `12m`, `2h10m`, `3d4h`.
 *
 * Deliberately NOT `format-utils.ts`'s `formatDuration`, which spaces its units
 * (`2h 10m`) — every cell counts on a row that already sheds fields, and this
 * form never exceeds six columns (widest: `23h59m`).
 */
export function formatResetCountdown(msRemaining: number): string {
  const totalMinutes = Math.floor(msRemaining / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

interface RenderedWindow {
  readonly label: string;
  readonly state: QuotaWindowState;
  readonly severity: QuotaSeverity;
}

function collectWindows(windows: QuotaWindows): RenderedWindow[] {
  const collected: RenderedWindow[] = [];
  if (windows.fiveHour !== undefined) {
    collected.push({
      label: '5h',
      state: windows.fiveHour,
      severity: severityOf(windows.fiveHour.utilization),
    });
  }
  if (windows.sevenDay !== undefined) {
    collected.push({
      label: '7d',
      state: windows.sevenDay,
      severity: severityOf(windows.sevenDay.utilization),
    });
  }
  return collected;
}

/** Highest-utilization window — the one that will actually cut the session off first. */
function bindingWindow(collected: RenderedWindow[]): RenderedWindow | undefined {
  return collected.reduce<RenderedWindow | undefined>(
    (worst, w) => (worst === undefined || w.state.utilization > worst.state.utilization ? w : worst),
    undefined,
  );
}

function maxSeverity(collected: RenderedWindow[]): QuotaSeverity {
  if (collected.some((w) => w.severity === 'critical')) return 'critical';
  if (collected.some((w) => w.severity === 'caution')) return 'caution';
  return 'calm';
}

/**
 * Render the quota segment, or `undefined` when neither window is known — the
 * permanent state under API-key auth, where the caller must draw no segment at
 * all rather than a placeholder.
 *
 * `now` is injectable for tests; production callers omit it.
 */
export function formatQuotaIndicator(windows: QuotaWindows, now: Date = new Date()): QuotaIndicator | undefined {
  const collected = collectWindows(windows);
  if (collected.length === 0) return undefined;

  const severity = maxSeverity(collected);
  const stale =
    windows.observedAt !== undefined && now.getTime() - windows.observedAt.getTime() > STALE_AFTER_MS;

  // Only the binding window earns a countdown, and only once it matters: a calm
  // row stays at its old width, and a hot row spends its extra cells on the one
  // deadline that is actually load-bearing.
  const binding = severity === 'calm' ? undefined : bindingWindow(collected);

  const rendered = collected.map((w) => {
    const tone = toneFor(w.severity);
    const percent = `${Math.round(w.state.utilization * 100)}%`;
    let text = `${palette.meta(w.label)} ${tone(percent)}`;
    if (w === binding && w.state.resetsAt !== undefined) {
      const msLeft = w.state.resetsAt.getTime() - now.getTime();
      // A non-positive countdown means the window already rolled over, so the
      // utilization beside it is stale too — showing `⟳0m` would assert a
      // deadline that has passed. Omit rather than mislead.
      if (msLeft > 0) text += ` ${palette.meta(`${RESET_GLYPH}${formatResetCountdown(msLeft)}`)}`;
    }
    return text;
  });

  const prefix = stale ? palette.meta('~') : '';
  return { text: prefix + rendered.join(palette.dim(' · ')), severity, stale };
}
