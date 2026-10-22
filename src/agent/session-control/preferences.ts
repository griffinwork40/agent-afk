import type { SessionStats, ThinkingUiMode } from '../../cli/slash/types.js';
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
