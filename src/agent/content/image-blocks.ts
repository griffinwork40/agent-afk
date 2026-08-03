/**
 * Shared helper for appending image-content blocks to a ContentBlockParam array.
 *
 * Invariant: this is the single source of truth for image-tail encoding used by
 * `buildUserPayload`, `buildSkillInvocationMessage`, and path-backed subagent
 * dispatch in `SubagentExecutor`.
 *
 * Contract: mutates `blocks` in place and returns void.
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

// Structural input keeps this agent-layer helper independent of the CLI attachment lifecycle.
export interface ImageBlockAttachment {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly bytes: Buffer;
}

export function appendImageBlocks(
  blocks: ContentBlockParam[],
  attachments: readonly ImageBlockAttachment[] | undefined,
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
