/**
 * Last-resort console diagnostic for a `messages.create` rejection that the
 * shape of the outgoing history most likely caused.
 *
 * Extracted from `loop.ts` unchanged. Deliberately side-effecting (writes to
 * `console.error`, returns nothing) and deliberately total — a diagnostic that
 * throws while explaining a throw is worse than no diagnostic, so the whole
 * body is wrapped in a swallowing `catch`.
 *
 * @module agent/providers/anthropic-direct/loop/thinking-diagnostic
 */

import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

/**
 * Scan `messages` for assistant `thinking` blocks missing either their text or
 * their `signature`, and print what was found alongside the API's own error
 * message. An extended-thinking turn replayed without a valid signature is
 * rejected by the Messages API with an opaque 400, so naming the offending
 * block index is usually the difference between a five-minute and a two-hour
 * debug.
 *
 * @param messages - The history that was sent (and rejected).
 * @param error    - The rejection, whose `.message` is echoed for correlation.
 */
export function dumpThinkingDiagnostic(messages: MessageParam[], error: Error): void {
  try {
    const offending: Array<{ msgIdx: number; blockIdx: number; thinking: string; sigLen: number }> = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
      const blocks = msg.content as ContentBlockParam[];
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j]!;
        if ((b as { type: string }).type === 'thinking') {
          const tb = b as { thinking?: string; signature?: string };
          if (!tb.thinking || !tb.signature) {
            offending.push({
              msgIdx: i,
              blockIdx: j,
              thinking: tb.thinking ? `(${tb.thinking.length} chars)` : '(empty)',
              sigLen: tb.signature?.length ?? 0,
            });
          }
        }
      }
    }
    console.error(
      '[afk] thinking-block diagnostic — API rejected request with:',
      error.message,
    );
    console.error(
      `[afk]   messages.length=${messages.length}, invalid thinking blocks:`,
      offending.length > 0 ? JSON.stringify(offending) : 'none found (cause may be elsewhere)',
    );
  } catch {
    // diagnostic must never throw
  }
}
