/**
 * Skill-side helper for emitting a {@link CardSpec} as a `panel` OutputEvent
 * to the ambient progress sink. Intended for any skill (built-in or
 * user-authored) that wants to surface a structured visual checkpoint
 * mid-execution — e.g. between phases of a multi-step skill.
 *
 * The helper is a no-op when no sink is active (tests, daemon, headless).
 * When a sink is active (interactive REPL, Telegram, daemon-with-renderer),
 * the renderer flushes pending markdown / tool-lane state and renders the
 * card via {@link card} from `src/cli/render.ts`.
 *
 * @module skills/_lib/emit-card
 */

import { getCurrentSink } from '../../agent/_lib/skill-sink-channel.js';
import type { CardSpec } from '../../cli/render.js';

/**
 * Emit a card to the ambient progress sink. No-op when no sink is set.
 *
 * @param spec - Card specification (kind, optional title, body).
 */
export function emitCard(spec: CardSpec): void {
  const sink = getCurrentSink();
  if (!sink) return;
  sink({ type: 'panel', spec }, { subagentId: '__main__' });
}
