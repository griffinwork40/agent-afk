/**
 * Per-key live application of `/config` writes to the RUNNING session.
 *
 * Before this, every `/config` write printed `RESTART_NOTE` — 100% of them —
 * even though the REPL already mutates two of those very settings live:
 * `/model` calls `session.setModel()` (slash/commands/info.ts:287) and `/theme`
 * calls `applyTheme()` (slash/commands/theme.ts:64). So the canonical settings
 * surface was the *worst* way to change your model.
 *
 * Contract — deliberately narrow:
 *   - A key is live-appliable ONLY if it appears in {@link LIVE_APPLIERS}. Every
 *     other key keeps today's exact behaviour (persist + "next restart").
 *   - We do NOT invalidate the loader's config caches globally. That would make
 *     an unbounded set of keys change underneath subsystems that read config
 *     more than once per session — `permissionMode` resolving differently at two
 *     call sites is a security-relevant inconsistency, not a feature. Explicit
 *     per-key handlers keep the blast radius equal to the key being edited.
 *   - Persistence already happened before we are called. A live-apply failure is
 *     therefore NON-FATAL and reported as "saved, but not applied live" — never
 *     as a failed write, because the write did land.
 *
 * @module cli/config/live-apply
 */

import { applyTheme, parseThemeMode, resolveTheme } from '../theme.js';

/**
 * The capabilities a surface must supply for live application. Structural, not a
 * session import: keeps this module testable with plain fakes and avoids dragging
 * the agent layer into the CLI config tier.
 */
export interface LiveApplyHandle {
  /** Swap the running session's model. Mirrors `/model`. */
  setModel(id: string): Promise<void>;
  /** Record the new model on the surface's stats so the status line agrees. */
  noteModel?(id: string): void;
  /** Repaint the status line / active frame after a visible change. */
  repaint?(): void;
}

export type LiveApplyOutcome =
  | { readonly applied: true; readonly note: string }
  | { readonly applied: false; readonly reason?: string };

type LiveApplier = (raw: string, handle: LiveApplyHandle) => Promise<LiveApplyOutcome>;

/**
 * Invariant: only add a key here once its live path is proven by an existing
 * mid-session mutator. Both current entries mirror a shipped slash command.
 */
const LIVE_APPLIERS: Readonly<Record<string, LiveApplier>> = {
  model: async (raw, handle) => {
    await handle.setModel(raw);
    handle.noteModel?.(raw);
    handle.repaint?.();
    return { applied: true, note: 'applied to this session' };
  },
  theme: async (raw, handle) => {
    const mode = parseThemeMode(raw);
    if (mode === undefined) return { applied: false, reason: `unrecognised theme "${raw}"` };
    const resolved = resolveTheme(mode);
    applyTheme(resolved);
    handle.repaint?.();
    const detail = mode === 'auto' ? ` (auto → ${resolved})` : '';
    return { applied: true, note: `applied to this session${detail}` };
  },
};

/** Whether a write to `path` can take effect without a restart. */
export function isLiveAppliable(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(LIVE_APPLIERS, path);
}

/** Config paths that apply immediately — used by tests and help text. */
export function liveAppliableKeys(): readonly string[] {
  return Object.keys(LIVE_APPLIERS);
}

/**
 * Apply an already-persisted config write to the running session.
 *
 * Never throws: a handler that rejects is reported as `applied: false` with the
 * error message, because the value is already on disk and the caller must not
 * present a successful write as a failure.
 */
export async function applyConfigLive(
  path: string,
  rawValue: string,
  handle: LiveApplyHandle | undefined,
): Promise<LiveApplyOutcome> {
  const applier = LIVE_APPLIERS[path];
  if (!applier) return { applied: false };
  if (!handle) return { applied: false, reason: 'no live session on this surface' };
  try {
    return await applier(rawValue, handle);
  } catch (err) {
    return { applied: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
