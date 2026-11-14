import type { SessionStats, ThinkingUiMode } from '../../cli/slash/types.js';
import { setUsageAwareness } from '../usage/usage-awareness-toggle.js';
import type { FastModeContext, FastModeController, FastModePreference, FastModeStatus } from '../fast-mode.js';
import { saveSession } from '../../cli/session-store.js';
import { slugifySessionName } from '../../cli/session-name.js';

export interface SessionNameOptions {
  /** Surface-owned presence notification; must be synchronous/best-effort. */
  onName?: (name: string) => void;
  persist?: (stats: SessionStats) => void;
}
export type SetSessionNameResult =
  | { ok: false }
  | { ok: true; name: string; saved: boolean; saveError?: unknown };

/** Metadata rename, never a second session/sidecar. Defer save until first turn. */
export function setSessionName(
  stats: SessionStats,
  raw: string,
  options: SessionNameOptions = {},
): SetSessionNameResult {
  const name = slugifySessionName(raw.trim());
  if (!name) return { ok: false };
  stats.name = name;
  stats.nameExplicit = true;
  stats.displayName = sessionDisplayName(raw);
  options.onName?.(name);
  if (stats.totalTurns === 0) return { ok: true, name, saved: false };
  try {
    (options.persist ?? saveSession)(stats);
    return { ok: true, name, saved: true };
  } catch (saveError) {
    // Renaming itself succeeded, even if its durable write did not.
    return { ok: true, name, saved: false, saveError };
  }
}

/** Max characters kept of a verbatim `/name` (display only; the slug is capped separately). */
const MAX_DISPLAY_NAME_LEN = 80;

/** The typed `/name` text, made safe to display: no control chars, single spaces, capped. */
export function sessionDisplayName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME_LEN).trim();
}

export const THINKING_MODES: readonly ThinkingUiMode[] = ['summary', 'live', 'digest', 'off'];

export function getSessionThinking(stats: Pick<SessionStats, 'thinkingUi'>): ThinkingUiMode {
  return stats.thinkingUi ?? 'live';
}

/** Display-only preference; effective on the next turn, no provider mutation. */
export function setSessionThinking(
  stats: Pick<SessionStats, 'thinkingUi'>,
  value: string,
): { ok: true; mode: ThinkingUiMode } | { ok: false } {
  const mode = value.trim().toLowerCase() as ThinkingUiMode;
  if (!THINKING_MODES.includes(mode)) return { ok: false };
  stats.thinkingUi = mode;
  return { ok: true, mode };
}

// ---------------------------------------------------------------------------
// Usage awareness
// ---------------------------------------------------------------------------

export function getUsageAwareness(stats: Pick<SessionStats, 'usageAwareness'>): boolean {
  return stats.usageAwareness !== false;
}

export function setUsageAwarenessPreference(
  stats: Pick<SessionStats, 'usageAwareness'>,
  value: string,
): { ok: true; enabled: boolean } | { ok: false } {
  const v = value.trim().toLowerCase();
  if (v !== 'on' && v !== 'off') return { ok: false };
  const enabled = v === 'on';
  stats.usageAwareness = enabled;
  setUsageAwareness(enabled);
  return { ok: true, enabled };
}

// ---------------------------------------------------------------------------
// Fast mode
// ---------------------------------------------------------------------------

export function readSessionFast(
  controller: FastModeController,
  context: FastModeContext,
): FastModeStatus {
  return controller.resolveStatus(context);
}

export function setSessionFast(
  controller: FastModeController,
  value: string,
): { ok: true; preference: FastModePreference } | { ok: false } {
  const preference = value.trim().toLowerCase();
  if (preference !== 'on' && preference !== 'off') return { ok: false };
  controller.setPreference(preference);
  return { ok: true, preference };
}
