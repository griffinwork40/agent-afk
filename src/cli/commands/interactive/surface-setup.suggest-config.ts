import type { InputSurface } from '../../input/input-surface.js';
import type { SuggestContext, SuggestEngine } from '../../input/suggest.js';
import { env } from '../../../config/env.js';
import type { HistorySubmissionTracker } from './surface-setup.history-tracking.js';

/**
 * Live stats read lazily by the suggest context closure on each keystroke.
 * Captured as a ref object so mid-session `/model` swaps are reflected
 * automatically without reinstalling the compositor.
 */
export interface SuggestCtxStats {
  model: string | undefined;
  cwd?: string | undefined;
  turns: readonly { user: string; assistant: string }[];
}

/**
 * Build the `suggest` config block that `armCompositor` receives.
 *
 * Returns the spread-ready `{ suggest: { engine, getContext } }` object when
 * ghost text is enabled, or an empty object when disabled (AFK_SUGGEST_GHOST=0
 * or JSON `interactive.suggestGhost: false`).
 *
 * Extracted from `surface-setup.ts` to stay under the 350-line ceiling.
 * The closure re-reads live config on each call so `/model` swaps and
 * runtime env changes take effect without restarting the REPL.
 */
export function buildSuggestConfig(opts: {
  enabled: boolean;
  engine: SuggestEngine;
  surface: InputSurface;
  stats: SuggestCtxStats;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  historyTracker: HistorySubmissionTracker;
}): { suggest: { engine: SuggestEngine; getContext: () => SuggestContext } } | Record<string, never> {
  if (!opts.enabled) return {};

  const { engine, surface, stats, historyTracker } = opts;

  return {
    suggest: {
      engine,
      getContext: () => ({
        model: stats.model as string,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        cwd: stats.cwd ?? process.cwd(),
        getHistory: () => {
          // `surface.history` is always a `ReplHistory` at runtime — the
          // InputSurface constructor calls `loadHistory()` which returns one.
          // We narrow to `ReplHistory` via duck-typing (`getEntries` method)
          // so we never import `ReplHistory` directly (avoids a circular-ish
          // dep and keeps the interface boundary clean).
          const ring = surface.history as { getEntries?: () => readonly string[] };
          return ring.getEntries ? [...ring.getEntries()] : [];
        },
        // O(1) — cached at push time; see surface-setup.history-tracking.ts.
        get lastSubmitted() {
          return historyTracker.getLastSubmitted();
        },
        getDropdownTopCandidate: (buffer: string) => {
          const ac = surface.autocompleteState;
          const top = ac.candidates[0];
          if (!top) return null;
          // Only return the candidate's value if it starts with the buffer
          // (strict-prefix check mirrors getDeterministicGhost's own guard).
          return top.value.startsWith(buffer) && top.value.length > buffer.length
            ? top.value
            : null;
        },
        getTranscriptTail: () => {
          // Last 1-2 completed turns, newest-first so the freshest
          // exchange wins buildUser's 200-char context budget. slice(-2)
          // returns a fresh array, so reverse() never mutates stats.turns.
          // Secrets are scrubbed downstream at the suggester egress
          // boundary (buildUser -> redactSecrets), not here.
          const turns = stats.turns;
          if (turns.length === 0) return '';
          return turns
            .slice(-2)
            .reverse()
            .map((t: { user: string; assistant: string }) => `user: ${t.user}\nassistant: ${t.assistant}`)
            .join('\n');
        },
        getRecentCommands: () => {
          // Reuse the same ReplHistory ring as getHistory above
          // (getEntries() is newest-first); buildUser slices to 5.
          const ring = surface.history as { getEntries?: () => readonly string[] };
          return ring.getEntries ? [...ring.getEntries()] : [];
        },
        // Parse as a boolean, not raw truthiness: only the documented
        // activations (1/true/yes/on — see docs/env-registry.md) enable the
        // Tier-2 LLM. A non-empty falsy value like `0` or `false` must keep
        // suggestions off, otherwise typing would start firing provider calls
        // despite the user explicitly disabling them.
        llmEnabled: () => /^(1|true|yes|on)$/i.test(env.AFK_SUGGEST_ENABLED ?? ''),
        // Same documented-activation parse as llmEnabled. Gates ONLY the
        // empty-prompt suggestion; the completion tiers are unaffected.
        promptSuggestEnabled: () =>
          /^(1|true|yes|on)$/i.test(env.AFK_SUGGEST_PROMPT ?? ''),
      }),
    },
  };
}
