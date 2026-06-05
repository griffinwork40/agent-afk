/**
 * Shared helper for appending image-content blocks to a ContentBlockParam array.
 *
 * Invariant: this is the single source of truth for the image-tail encoding
 * used by every slash-layer encoder. Two callers need it today:
 *   - `buildUserPayload` (user-payload.ts) — regular user-turn messages.
 *   - `buildSkillInvocationMessage` (skill-message-bridge.ts) — skill dispatch.
 *
 * The encoders themselves stay separate because each produces a different
 * text-block shape that's load-bearing (the skill bridge's 2-block
 * breadcrumb + instruction tail is recognized by the model and cannot merge
 * into one block). The image loop is identical between them, though, and
 * lives here so a future image-format change (e.g. URL-source vs.
 * base64-source) cannot drift across encoders.
 *
 * Contract: mutates `blocks` in place — `attachments?` is read-only. Returns
 * void; the caller already owns the array.
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { ImageAttachment } from '../../input/attachments.js';

export function appendImageBlocks(
  blocks: ContentBlockParam[],
  attachments: readonly ImageAttachment[] | undefined,
): void {
  for (const att of attachments ?? []) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mediaType,
        data: att.bytes.toString('base64'),
      },
    });
  }
}
