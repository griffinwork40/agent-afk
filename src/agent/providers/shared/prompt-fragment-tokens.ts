/**
 * Lightweight per-fragment token-count logging at prompt assembly time (#4449).
 *
 * Emits a single `session_phase` trace event with phase `prompt_fragment_sizes`
 * whose `metadata` maps each named fragment to its estimated token count
 * (`Math.ceil(chars / 4)` — a cheap chars-per-token proxy). Empty fragments
 * are omitted so the record is sparse. Read-path only: the prompt strings are
 * never mutated.
 *
 * Called once per session, immediately after the system-prompt assembler
 * returns, from both the AnthropicDirect and OpenAI-compatible providers.
 *
 * @module agent/providers/shared/prompt-fragment-tokens
 */

import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/writer.js';

/** Named fragments whose sizes are logged. Keys match the assembler invariant
 *  documented in `anthropic-direct/query/system-prompt.ts` and
 *  `openai-compatible/system-prompt-wiring.ts`. */
export interface PromptFragments {
  toolBase?: string;
  userSystem?: string | null;
  memoryPrompt?: string;
  workspacePrompt?: string;
  hotMemory?: string;
  goalPrompt?: string;
  /** The assembled `# Environment` fragment (cwd-dependent). */
  environment?: string;
  manifest?: string;
  agentTypeListing?: string;
}

/**
 * Emit a `prompt_fragment_sizes` session-phase event carrying per-fragment
 * token estimates. A no-op when `traceWriter` is absent (same contract as
 * every other `emit*` helper).
 *
 * @param traceWriter - The session's trace sink; may be undefined.
 * @param fragments   - Named prompt fragments as assembled strings.
 */
export function logFragmentTokens(
  traceWriter: TraceSink | undefined,
  fragments: PromptFragments,
): void {
  if (!traceWriter) return;

  const metadata: Record<string, number> = {};
  for (const [key, value] of Object.entries(fragments)) {
    if (typeof value === 'string' && value.length > 0) {
      metadata[key] = Math.ceil(value.length / 4);
    }
  }

  // Fire-and-forget: trace emission must never block or throw into the caller.
  void emitSessionPhase(traceWriter, { phase: 'prompt_fragment_sizes', metadata });
}

/**
 * Convenience wrapper for the anthropic-direct path: accepts a
 * `StableSystemParts`-shaped object directly so the call site stays
 * one line and `setUpQuerySession` remains within the 200-line ceiling.
 *
 * `userSystem` is `string | null` in `StableSystemParts`; null is treated as
 * absent (same as an empty string) by `logFragmentTokens`.
 */
export function logStablePartsTokens(
  traceWriter: TraceSink | undefined,
  parts: {
    toolBase: string;
    userSystem: string | null;
    memoryPrompt: string;
    workspacePrompt: string;
    hotMemory: string;
    goalPrompt?: string;
    manifest: string;
    agentTypeListing?: string;
  },
): void {
  logFragmentTokens(traceWriter, parts);
}
