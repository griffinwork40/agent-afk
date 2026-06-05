/**
 * Shared factory for constructing a StreamRenderer in the slash-skill context.
 *
 * Encapsulates the Stage 3e compositor-borrow pattern that must be applied at
 * every `SlashContext`-owned StreamRenderer construction site:
 *
 *   1. Borrow the REPL's persistent TerminalCompositor via `ctx.getCompositor`
 *      (or accept null when unavailable — Telegram, daemon, non-TTY, tests).
 *   2. Pass it through the conditional spread-guard so the renderer skips
 *      constructing a second compositor on the same terminal.
 *
 * Three sites currently use this pattern:
 *   - `src/cli/slash/builtin-skills.ts`
 *   - `src/cli/slash/plugin-skills.ts`
 *   - `src/cli/slash/commands/init.ts`
 *
 * `turn-handler.ts` uses a structurally different construction (borrows via
 * `h.getCompositor`, spreads ~6 REPL-specific options) and is intentionally
 * NOT covered by this factory.
 */

import { env } from '../../../config/env.js';
import { StreamRenderer } from '../../_lib/stream-renderer.js';
import type { SlashContext, Writer } from '../types.js';

export interface SkillRendererOpts {
  /** Skill name rendered in the visual badge when the model emits XML tags. */
  skillName: string;
  /**
   * Whether to enable verbose/live thinking-mode output.
   * Defaults to `env.AFK_SKILL_STREAM_VERBOSE === '1'`.
   */
  verbose?: boolean;
  /**
   * Override the Writer used for non-TTY / line-based output.
   * Defaults to `ctx.out`.
   *
   * Pass an explicit override only when the call site has a specific routing
   * requirement (e.g. `init.ts` preserves `createConsoleWriter()` for
   * now — see the TODO there).
   */
  out?: Writer;
  /** Cancel callback forwarded to the compositor. Defaults to a no-op. */
  onCancel?: () => void;
}

/**
 * Construct a `StreamRenderer` for a slash-skill handler.
 *
 * Borrows the REPL's persistent `TerminalCompositor` from `ctx` so the
 * renderer doesn't spin up a competing compositor on the same terminal,
 * then wraps the borrow in the conditional spread-guard so null/undefined
 * contexts fall back to the renderer's own-compositor path.
 */
export function createSkillRenderer(ctx: SlashContext, opts: SkillRendererOpts): StreamRenderer {
  const verbose = opts.verbose ?? env.AFK_SKILL_STREAM_VERBOSE === '1';
  const out = opts.out ?? ctx.out;

  // Stage 3e — borrow the REPL's persistent TerminalCompositor so the
  // renderer skips constructing a second compositor / second
  // `createLogUpdate(stdout)` on the same terminal. Two log-update
  // instances tracking one stdout interleave ANSI cursor-move sequences
  // and produce the "stacked prompt" rendering bug.
  //
  // When `getCompositor` is undefined (Telegram, daemon, tests that
  // never wire it) or returns null (non-TTY, surfaces that don't arm),
  // the renderer falls back to the own-compositor path. Mirrors the
  // spread-guard pattern at `commands/interactive/turn-handler.ts`.
  const borrowedCompositor = ctx.getCompositor?.() ?? null;

  return new StreamRenderer({
    out,
    verbose,
    activeSkillName: opts.skillName,
    onCancel: opts.onCancel ?? (() => { /* no-op */ }),
    ...(borrowedCompositor ? { compositor: borrowedCompositor } : {}),
  });
}
