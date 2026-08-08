/**
 * Lifecycle + concurrency state for the empty-prompt suggestion.
 *
 * `./suggest-prompt` knows how to PRODUCE one proposal (prompt construction,
 * validation, one provider round-trip). This module owns everything about the
 * proposal's LIFE: which invocation is current, which controller may be
 * aborted, whether a late reply is still allowed to publish, and when the
 * stored value is dropped.
 *
 * Newest-wins contract: every {@link PromptSuggestionState.prime} call takes a
 * monotonically increasing invocation id and aborts its predecessor. A reply
 * from an older invocation may neither PUBLISH its result nor CLEAR the newer
 * one's stored value nor release the newer one's controller — every mutation is
 * guarded by an `id === current` identity check. Without that guard an
 * out-of-order resolve (slow turn N landing after fast turn N+1) either shows
 * turn N's stale proposal or wipes turn N+1's fresh one.
 *
 * @module cli/input/suggest-prompt-state
 */

import { generatePromptSuggestion } from './suggest-prompt.js';
import type { CompleteFn, SuggestContext } from './suggest-types.js';

/** Collaborators supplied by the engine that composes this state. */
export interface PromptSuggestionStateDeps {
  /** Suggestion-class model id for the given context. */
  pickModel(ctx: SuggestContext): string;
  /** Resolve the completion function, or null when the provider cannot complete. */
  resolveComplete(model: string, ctx: SuggestContext): CompleteFn | null;
  /** Hard abort budget (ms). */
  timeoutMs: number;
  /** Control-character scrubber applied to an accepted reply. */
  scrub(s: string): string;
  /** Diagnostic sink for a thrown completion. NOT called on abort/timeout. */
  onError?: (err: unknown) => void;
}

export interface PromptSuggestionState {
  /**
   * Generate a proposal for this turn and store it for {@link peek}.
   * Aborts any in-flight predecessor first; a superseded invocation can never
   * publish or clear. Never throws.
   */
  prime(ctx: SuggestContext): Promise<void>;
  /** The stored proposal, or null. Synchronous — read on the render path. */
  peek(): string | null;
  /**
   * Drop the stored proposal (accepted, dismissed, or the user started
   * editing). Also invalidates the in-flight invocation so a reply that is
   * already on the wire cannot re-publish the value the caller just cleared.
   */
  clear(): void;
  /** Abort the in-flight prime and drop the stored proposal. */
  dispose(): void;
}

export function createPromptSuggestionState(
  deps: PromptSuggestionStateDeps,
): PromptSuggestionState {
  let suggestion: string | null = null;
  let controller: AbortController | null = null;
  /**
   * Identity of the invocation whose result is currently authoritative.
   * Bumped by prime() (a newer request wins) and by clear()/dispose() (an
   * explicit drop wins over anything already in flight).
   */
  let currentId = 0;

  /** Abort + release the live controller, without touching the stored value. */
  function abortInFlight(): void {
    if (controller !== null) {
      controller.abort();
      controller = null;
    }
  }

  return {
    async prime(ctx) {
      // Newest-wins: the predecessor loses the slot before the successor takes
      // it, so at most one provider call is ever outstanding.
      abortInFlight();
      const id = ++currentId;
      // The previous turn's proposal is stale the moment a new one is
      // requested; drop it now rather than leaving it visible until (or
      // beyond) the new reply.
      suggestion = null;

      const result = await generatePromptSuggestion(ctx, {
        model: deps.pickModel(ctx),
        timeoutMs: deps.timeoutMs,
        scrub: deps.scrub,
        ...(deps.onError ? { onError: deps.onError } : {}),
        onController: (c) => {
          // Controller identity: only the CURRENT invocation may install or
          // release the shared controller slot. A superseded call's cleanup
          // (`onController(null)` in generatePromptSuggestion's finally) would
          // otherwise drop the live controller and make the successor
          // un-abortable.
          if (id !== currentId) return;
          controller = c;
        },
        resolveComplete: (model) => deps.resolveComplete(model, ctx),
      });

      // Invocation identity: a late reply from a superseded prime must not
      // publish over the newer proposal (or over an explicit clear()).
      if (id !== currentId) return;
      suggestion = result;
    },

    peek() {
      return suggestion;
    },

    clear() {
      // Bump the id so an in-flight reply cannot resurrect what was cleared.
      // The request itself is left running (it is cheap, already paid for, and
      // aborting here would race the accept path's own teardown) — it simply
      // has no way to publish.
      currentId++;
      suggestion = null;
    },

    dispose() {
      currentId++;
      suggestion = null;
      abortInFlight();
    },
  };
}
