import { TELEGRAM_MAX_CHARS } from './elicitation-choice-list.js';
import { palette } from '../cli/palette.js';

// Invariant: Telegram rejects messages with malformed HTML. Every chunk emitted
// by splitLongPrompt must be self-contained valid HTML — open tags closed before
// the chunk boundary, reopened at the start of the next chunk.
// The supported inline tags are the Telegram HTML subset: b, i, code, pre.

/** Tags that Telegram HTML mode supports and that can be opened/closed mid-split. */
const SPLITTABLE_TAGS = ['b', 'i', 'code', 'pre'] as const;
type SplittableTag = (typeof SPLITTABLE_TAGS)[number];

/**
 * Walk `text` from 0..end and return a stack of currently-open tag names
 * (innermost last). Only tracks tags in SPLITTABLE_TAGS.
 */
function openTagStack(text: string, end: number): SplittableTag[] {
  const stack: SplittableTag[] = [];
  let i = 0;
  while (i < end) {
    if (text[i] !== '<') { i++; continue; }
    // Find end of tag
    const close = text.indexOf('>', i);
    if (close === -1 || close >= end) break;
    const raw = text.slice(i + 1, close);
    const isClose = raw.startsWith('/');
    const name = (isClose ? raw.slice(1) : raw.split(/\s/)[0] ?? '').toLowerCase();
    if ((SPLITTABLE_TAGS as readonly string[]).includes(name)) {
      if (isClose) {
        // Pop matching tag (innermost)
        const idx = stack.lastIndexOf(name as SplittableTag);
        if (idx !== -1) stack.splice(idx, 1);
      } else {
        stack.push(name as SplittableTag);
      }
    }
    i = close + 1;
  }
  return stack;
}

/**
 * Return true when `splitAt` falls inside an HTML tag (`<…>`) or an HTML
 * entity (`&…;`). We scan backward a small window.
 */
function insideTagOrEntity(text: string, splitAt: number): boolean {
  // Check entity: look back up to 9 chars for an '&' with no closing ';'
  const ENTITY_MAX = 9;
  const entityStart = Math.max(0, splitAt - ENTITY_MAX);
  const preEntity = text.slice(entityStart, splitAt);
  const ampIdx = preEntity.lastIndexOf('&');
  if (ampIdx !== -1 && !preEntity.slice(ampIdx).includes(';')) return true;

  // Check tag: look back for '<' with no closing '>'
  const TAG_MAX = 30;
  const tagStart = Math.max(0, splitAt - TAG_MAX);
  const preTag = text.slice(tagStart, splitAt);
  const ltIdx = preTag.lastIndexOf('<');
  if (ltIdx !== -1 && !preTag.slice(ltIdx).includes('>')) return true;

  return false;
}

/**
 * Split a prompt that exceeds TELEGRAM_MAX_CHARS into chunks each ≤ maxLen.
 *
 * HTML-aware (Finding 1, issue #3663):
 *   - Never splits inside an HTML tag or HTML entity.
 *   - Tracks open inline tags at each split point; closes them at chunk end
 *     and reopens them at the next chunk start so every chunk is valid HTML.
 *   - Prefers splitting at the last newline within the window (existing
 *     behaviour) but validates that the candidate split is not inside a
 *     tag or entity before using it; falls back to scanning left for a safe
 *     boundary, then hard-splits at maxLen as a last resort.
 *
 * Off-by-one clarification (Finding 3, issue #3663):
 *   - `nlIdx >= 0` with an explicit zero-length guard: a newline at position 0
 *     would produce an empty first chunk, so we treat nlIdx === 0 as "no usable
 *     newline" and fall through to the hard-split path.
 *
 * Returns an array of at least one element. The caller sends all but the last
 * chunk as plain pre-messages, then sends the last chunk as the interceptable
 * prompt message (so only one message requires the user's reply).
 */
export function splitLongPrompt(prompt: string, maxLen: number = TELEGRAM_MAX_CHARS): string[] {
  if (prompt.length <= maxLen) return [prompt];

  const chunks: string[] = [];
  let remaining = prompt;
  let prefixTags: SplittableTag[] = []; // tags to reopen at next chunk start

  while (remaining.length > 0) {
    // Compute the reopen prefix for tags left open by the previous split.
    const reopenPrefix = prefixTags.map((t) => `<${t}>`).join('');
    // Reserve budget for: reopen prefix + worst-case close suffix.
    // Worst case close suffix: every SPLITTABLE_TAG closed = sum of "</tag>" lengths.
    const maxCloseSuffix = SPLITTABLE_TAGS.reduce((n, t) => n + `</${t}>`.length, 0);
    const contentBudget = maxLen - reopenPrefix.length - maxCloseSuffix;

    if (remaining.length <= contentBudget) {
      // Everything fits — this is the last chunk, no close suffix needed.
      chunks.push(reopenPrefix + remaining);
      break;
    }

    const window = remaining.slice(0, contentBudget);

    // Find a safe split point: prefer last newline, fall back to scanning left.
    let splitAt = -1;
    const nlIdx = window.lastIndexOf('\n');
    if (nlIdx > 0 && !insideTagOrEntity(remaining, nlIdx)) {
      splitAt = nlIdx;
    } else {
      // Scan left from contentBudget for a safe boundary
      for (let pos = contentBudget - 1; pos > 0; pos--) {
        if (!insideTagOrEntity(remaining, pos)) {
          splitAt = pos;
          break;
        }
      }
    }
    if (splitAt <= 0) splitAt = contentBudget; // last resort

    // Determine which tags are open at the split boundary and close them.
    const chunkContent = remaining.slice(0, splitAt);
    const openAtSplit = openTagStack(reopenPrefix + chunkContent, (reopenPrefix + chunkContent).length);
    const closeSuffix = [...openAtSplit].reverse().map((t) => `</${t}>`).join('');

    chunks.push(reopenPrefix + chunkContent + closeSuffix);

    // Tags to reopen next chunk = tags that were open at the split point.
    prefixTags = openAtSplit;

    // Advance: consume the split character if it was a newline.
    const consumed = splitAt === nlIdx ? splitAt + 1 : splitAt;
    remaining = remaining.slice(consumed);
  }
  return chunks;
}

/**
 * Low-level send helper for Telegram choice elicitations.
 *
 * Extracted from elicitation-handler.ts to keep that file under the
 * 350-code-line ceiling (issue #3631).
 *
 * @module telegram/elicitation-handler.send
 */

/**
 * Send the choice pre-messages (if any) and then the keyboard message.
 * If any send fails, `onFailure` is called once.
 *
 * Fix (issue #3631, items 4 & 5):
 *   - Accepts `signal` and short-circuits once aborted (no keyboard sent
 *     after abort during pre-sends).
 *   - `console.warn`s send failures before calling `onFailure`, matching
 *     the text-path log prefix `[elicitation-handler]`.
 */
export function sendChoiceMessages(
  telegram: { sendMessage: (chatId: number, text: string, opts: object) => Promise<unknown> },
  chatId: number,
  preMessages: string[],
  keyboardText: string,
  threadOpts: object,
  keyboardOpts: object,
  onFailure: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const sendKeyboard = (): Promise<void> => {
    if (signal?.aborted) return Promise.resolve();
    return telegram
      .sendMessage(chatId, keyboardText, { parse_mode: 'HTML', ...threadOpts, ...keyboardOpts })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.warn(palette.warning(`[elicitation-handler] keyboard sendMessage failed; declining elicitation for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`),
        );
        onFailure();
      });
  };

  if (preMessages.length === 0) {
    return sendKeyboard();
  }

  const sendPre = async () => {
    for (const msg of preMessages) {
      if (signal?.aborted) return;
      await telegram.sendMessage(chatId, msg, { parse_mode: 'HTML', ...threadOpts });
    }
  };

  return sendPre().then(sendKeyboard).catch((err: unknown) => {
    console.warn(palette.warning(`[elicitation-handler] pre-message sendMessage failed; declining elicitation for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`),
    );
    onFailure();
  });
}
