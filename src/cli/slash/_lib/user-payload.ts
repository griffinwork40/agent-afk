/**
 * Canonical encoder for user-turn content block arrays.
 *
 * Single source of truth for building ContentBlockParam[] payloads that
 * include text + image attachments. Replaces the private `buildContentBlocks`
 * that previously lived in turn-handler.ts.
 *
 * NOTE: `buildSkillInvocationMessage` in skill-message-bridge.ts is intentionally
 * NOT unified here — it produces two separate text blocks (breadcrumb + instruction)
 * that form a load-bearing payload the model recognizes. Merging them into one
 * block would break the existing skill dispatch contract. The encoders stay
 * separate, but the image-tail loop is shared via `appendImageBlocks` (image-blocks.ts)
 * so a future image-format change can't drift between them.
 *
 * NOTE: `init.ts` contains a third independent encoder (out of scope) — known
 * exception to the "single encoder" goal.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { ImageAttachment } from '../../input/attachments.js';
import { appendImageBlocks } from './image-blocks.js';

/**
 * Build a ContentBlockParam array for a user message.
 *
 * Ordering (load-bearing — do not reorder):
 *   1. `manifestBlock` (if non-empty) — additive context prepended before the user text
 *   2. `fileBlocks` (if any) — `@`-referenced file contents, sit between the
 *      manifest and the user's text so the model reads the data before the ask
 *   3. `text` (if non-empty) — the user's message / skill instruction
 *   4. image blocks — one per attachment, in order
 *
 * @param text         The user's message text. Empty string → no text block emitted.
 * @param attachments  Zero or more image attachments.
 * @param manifestBlock  Optional preflight-context / system-reminder block prepended
 *                       before `text`. Whitespace-only values are treated as absent.
 * @param fileBlocks   Optional pre-built content blocks (e.g. `@`-file injections
 *                     from `expandAtFileTokens`) inserted after the manifest and
 *                     before the user text. Empty / absent → no-op.
 */
export function buildUserPayload(
  text: string,
  attachments: readonly ImageAttachment[],
  manifestBlock?: string,
  fileBlocks?: readonly ContentBlockParam[],
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];

  if (manifestBlock && manifestBlock.trim().length > 0) {
    blocks.push({ type: 'text', text: manifestBlock });
  }

  if (fileBlocks && fileBlocks.length > 0) {
    blocks.push(...fileBlocks);
  }

  if (text) {
    blocks.push({ type: 'text', text });
  }

  appendImageBlocks(blocks, attachments);

  return blocks;
}
