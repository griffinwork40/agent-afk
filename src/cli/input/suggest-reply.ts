/**
 * Interpretation of an LLM suggestion reply: normalizing the completion result,
 * joining a continuation onto the user's buffer, and dropping the cut-off word
 * of a reply that hit the token cap.
 *
 * Split out of `./suggest-tier2` so both suggestion producers (the Tier-2
 * inline completion and the empty-prompt proposal) share one definition of
 * "this reply was truncated".
 *
 * @module cli/input/suggest-reply
 */

import type { ProviderCompleteResult } from '../../agent/provider.js';

/** A completion reply with its stop reason, when the provider reported one. */
export interface NormalizedReply {
  text: string;
  /** True only when the provider reported a `max_tokens` stop. */
  truncated: boolean;
}

/**
 * Normalize a `CompleteFn` result. A bare string has no stop reason and is
 * therefore never treated as truncated (previous behaviour preserved).
 */
export function normalizeReply(raw: string | ProviderCompleteResult): NormalizedReply {
  if (typeof raw === 'string') return { text: raw, truncated: false };
  return { text: raw.text, truncated: raw.stopReason === 'max_tokens' };
}

/** The trailing (possibly partial) word of `buffer`; '' when it ends in whitespace. */
export function trailingWord(buffer: string): string {
  const match = /\S+$/.exec(buffer);
  return match === null ? '' : match[0];
}

/**
 * Join a model reply onto `buffer` and return the full candidate line, or null
 * when the reply is not a usable continuation.
 *
 * Contract: providers trim replies, so a bare suffix loses its leading space
 * and `buffer + reply` cannot tell "fix th" + "e bug" from "fix the" + "bug".
 * The Tier-2 prompt therefore asks the model to repeat the buffer's trailing
 * word and continue from it, which makes the join unambiguous. Accepted
 * shapes, in order:
 *   1. the reply repeats the whole buffer (older prompt / non-compliant model);
 *   2. the reply starts with the buffer's trailing word (the prompted shape);
 *   3. the buffer ends in whitespace, so the reply is the next text verbatim.
 * Anything else is rejected — the same safety role the old full-line prefix
 * guard played. The result must be strictly longer than `buffer`.
 */
export function joinContinuation(buffer: string, reply: string): string | null {
  if (reply.length === 0) return null;
  let line: string;
  if (reply.startsWith(buffer)) {
    line = reply;
  } else {
    const word = trailingWord(buffer);
    if (word.length === 0) {
      // Buffer ends in whitespace: reply is the next text verbatim. Guard
      // against a non-compliant model that repeats the last word: if the reply
      // starts with the word that precedes the trailing space, strip it so we
      // never yield "foo bar bar baz" when the buffer is "foo bar ".
      const prevWord = /\S+$/.exec(buffer.trimEnd())?.[0] ?? '';
      if (prevWord.length > 0) {
        // Model non-compliantly echoed the preceding word.
        if (reply === prevWord) return null; // bare echo with nothing new
        if (reply.startsWith(prevWord + ' '))
          line = buffer + reply.slice(prevWord.length + 1); // strip the duplicate
        else line = buffer + reply;
      } else {
        line = buffer + reply;
      }
    } else if (reply.toLowerCase().startsWith(word.toLowerCase())) line = buffer.slice(0, buffer.length - word.length) + reply;
    else return null;
  }
  return line.length > buffer.length ? line : null;
}

/**
 * Drop the final (possibly cut-off) word of `text`, then trailing whitespace.
 * Used on a `max_tokens` stop, where the last word may have been cut mid-way;
 * a complete word is occasionally dropped too, which is the safe direction.
 */
export function dropPartialWord(text: string): string {
  return text.replace(/\S*$/, '').trimEnd();
}

/**
 * Apply {@link dropPartialWord} to the part of `line` after `buffer`. Returns
 * null when no complete word of new text survives.
 */
export function trimTruncatedLine(buffer: string, line: string): string | null {
  const kept = dropPartialWord(line.slice(buffer.length));
  return kept.trim().length === 0 ? null : buffer + kept;
}
