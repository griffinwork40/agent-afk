/**
 * In-process diff-cap state machine for future diff output.
 * Already committed scrollback is not retained or re-rendered.
 *
 * Three states form a cycle: compact → expanded → full → compact.
 *
 *   compact   = AFK_DIFF_LINES env value (or 30 when unset/invalid)
 *   expanded  = 50 lines
 *   full      = 0  (unlimited)
 *
 * Pure module — zero terminal imports, zero chalk, zero process.stdout.
 * Env access goes through src/config/env.ts (mandatory indirection).
 *
 * Consumers: tool-lane-format-diff.ts (currentDiffCap replaces diffFlushMaxLines
 * in flush mode), surface-setup.ts (wires cycleDiffCap to the Ctrl+X D chord).
 */

import { env } from '../../../config/env.js';

export type DiffCapState = 'compact' | 'expanded' | 'full';

const COMPACT_DEFAULT = 30;   // matches FLUSH_DIFF_LINES_DEFAULT
const EXPANDED_VALUE  = 50;
const FULL_VALUE      = 0;    // 0 = unlimited

let _state: DiffCapState = 'compact';

/**
 * Current numeric diff body-line cap for flush mode.
 *
 * compact  → AFK_DIFF_LINES env value (same logic as diffFlushMaxLines()),
 *            defaulting to 30 when unset or invalid.
 * expanded → 50
 * full     → 0 (callers interpret 0 as "no cap")
 */
export function currentDiffCap(): number {
  if (_state === 'compact') {
    const raw = env['AFK_DIFF_LINES'];
    if (raw === undefined) return COMPACT_DEFAULT;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return COMPACT_DEFAULT;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return COMPACT_DEFAULT;
    return n;
  }
  if (_state === 'expanded') return EXPANDED_VALUE;
  return FULL_VALUE; // 'full'
}

/**
 * Advance the state one step and return the new state.
 * compact → expanded → full → compact (wraps).
 */
export function cycleDiffCap(): DiffCapState {
  _state =
    _state === 'compact'  ? 'expanded' :
    _state === 'expanded' ? 'full'     :
    'compact';
  return _state;
}

/**
 * Reset the state to compact (the initial/default state).
 * Explicit reset helper (also used by tests); not wired to session teardown.
 */
export function resetDiffCap(): void {
  _state = 'compact';
}

/**
 * Read the current state without advancing it.
 */
export function getDiffCapState(): DiffCapState {
  return _state;
}

/**
 * Selected-state notice emitted through the completion writer after cycling.
 * Scope is future diff output only, never expansion of existing scrollback.
 */
export function diffCapHint(): string {
  return `Future diff output: ${_state} (Ctrl+X D to cycle); existing output unchanged.`;
}
