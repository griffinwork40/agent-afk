/**
 * Telegram-surface `UserPromptSubmit` hook dispatch.
 *
 * Extracted from the per-turn dispatch point in `message.ts` so that file
 * remains within the 350-code-line ceiling. Mirrors the REPL's
 * `loop-iteration.hooks.ts` semantics:
 *
 *   - `decision: 'block'` / `HookBlockedError` → drop the turn (`shouldSkip: true`).
 *   - `HookHandlerTimeoutError`                → drop the turn (`shouldSkip: true`).
 *   - `injectContext` from a handler           → prepended to the outbound content.
 *   - `AbortError` and unexpected errors        → re-thrown unchanged.
 *
 * On Telegram there is no readline prompt to rearm after a block, and the
 * "blocked" notice is sent as a chat reply rather than a dim palette line.
 *
 * @module telegram/handlers/message.ups-dispatch
 */

import type { ContentBlockParam, DocumentBlockParam } from '@anthropic-ai/sdk/resources';
import type { HookRegistry, UserPromptSubmitContext } from '../../agent/hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { HookHandlerTimeoutError } from '../../agent/hook-registry.js';
import { prependToContent } from '../bg-injection.js';

/**
 * Result of {@link dispatchTelegramUserPromptSubmit}.
 *
 * `shouldSkip`  — a handler blocked or timed out; the caller should drop the
 *   turn (reply with `blockNotice` when present, then return early).
 * `content`     — the outbound content for this turn, possibly prefixed with a
 *   handler-returned `injectContext` string. Equal to the input content when
 *   no injection was returned.
 * `blockNotice` — human-readable block reason, present when `shouldSkip` is true.
 * `userText`    — plain text extracted from `content` for session-turn recording.
 *   Joined from text blocks for content-block arrays; the raw string otherwise.
 */
export interface TelegramUpsResult {
  shouldSkip: boolean;
  content: string | ContentBlockParam[];
  blockNotice?: string;
  userText: string;
}

/**
 * Extract the plain-text representation of a turn's content for session-turn
 * recording. Text blocks are joined; image/document blocks are labelled.
 *
 * Extracted from `processOne` so both the UPS path and the non-UPS path share
 * a single source of truth for the `userText` passed to `recordTelegramTurn`.
 */
export function extractUserText(content: string | ContentBlockParam[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'document') return `[document: ${(b as DocumentBlockParam).title ?? 'file'}]`;
      return '[image]';
    })
    .join(' ');
}

/**
 * Dispatch the `UserPromptSubmit` hook before a Telegram turn, and extract
 * the user-text for session recording.
 *
 * @param content      Outbound content about to be sent to the session.
 * @param registry     The session's hook registry (`session.hookRegistry`).
 * @param sessionId    Optional session id for context attribution.
 *
 * Returns `{ shouldSkip: true }` when the turn must be dropped. Rethrows
 * `AbortError` and all unexpected errors unchanged.
 */
export async function dispatchTelegramUserPromptSubmit(
  content: string | ContentBlockParam[],
  registry: HookRegistry | undefined,
  sessionId?: string,
): Promise<TelegramUpsResult> {
  const userText = extractUserText(content);

  if (!registry) return { shouldSkip: false, content, userText };

  const ctx: UserPromptSubmitContext = {
    event: 'UserPromptSubmit',
    prompt: userText,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };

  try {
    const decision = await registry.dispatch(ctx);
    const injection = decision.injectContext;
    const prefixed = injection ? prependToContent(injection + '\n\n', content) : content;
    return { shouldSkip: false, content: prefixed, userText };
  } catch (err) {
    if (err instanceof HookBlockedError) {
      const notice = err.reason
        ? `⊘ Turn blocked by hook: ${err.reason}`
        : '⊘ Turn blocked by hook';
      return { shouldSkip: true, content, blockNotice: notice, userText };
    }
    if (err instanceof HookHandlerTimeoutError) {
      const notice = `⊘ Turn blocked by hook: handler timed out after ${err.timeoutMs}ms`;
      return { shouldSkip: true, content, blockNotice: notice, userText };
    }
    // AbortError and unexpected errors propagate to the caller.
    throw err;
  }
}
