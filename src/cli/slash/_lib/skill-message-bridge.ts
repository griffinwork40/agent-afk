/**
 * Builds a multi-block ContentBlockParam message for skill invocation via sendMessageStream.
 *
 * NOTE: This assembler intentionally does NOT delegate to buildUserPayload (user-payload.ts)
 * because it produces two separate text blocks (breadcrumb + instruction) that form a
 * load-bearing payload the model recognizes. Merging them into a single block would change
 * the payload structure and break the skill dispatch contract. The image-tail loop IS
 * shared with buildUserPayload via `appendImageBlocks` (image-blocks.ts) so a future
 * image-format change cannot drift between the two encoders.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { SkillMetadata } from '../../../skills/index.js';
import type { ImageAttachment } from '../../input/attachments.js';
import { formatCommandBreadcrumb } from './command-tags.js';
import { appendImageBlocks } from './image-blocks.js';

/**
 * Builds the message to send when a skill is invoked via slash command.
 *
 * Default shape — 2 blocks (load-bearing, do not reorder):
 *   Block 1: breadcrumb with XML tags (visible anchor for "skill is loaded" guidance).
 *   Block 2: instruction to dispatch via the skill tool.
 *
 * When a `manifestBlock` is passed (from a registered SkillPreflight), a
 * third text block is prepended *before* the breadcrumb. The model reads
 * the manifest as additive context, then sees the same breadcrumb +
 * instruction pair it has always seen — so the `skill`-tool dispatch path
 * the model recognizes is preserved bit-for-bit at the tail of the array.
 *
 * @param skill - Skill metadata from the skill registry.
 * @param args  - Raw argument string from the slash command invocation.
 * @param manifestBlock - A03: Optional preflight manifest to prepend as additive
 *   context before the breadcrumb block. Must be trusted-origin content only —
 *   pass the `manifestBlock` field from `SkillPreflight`'s return value; never
 *   pass user-supplied text here. When undefined or empty/whitespace, the
 *   function falls back to the standard 2-block shape unchanged.
 *
 * When `attachments` are passed, one image block per attachment is appended
 * after the instruction block. The images are adjacent to the dispatch
 * instruction so the model sees them as part of the skill invocation context.
 */
export function buildSkillInvocationMessage(
  skill: SkillMetadata,
  args: string,
  manifestBlock?: string,
  attachments?: readonly ImageAttachment[],
): ContentBlockParam[] {
  const breadcrumb = formatCommandBreadcrumb(skill.name, args);

  const forkNote =
    skill.context === 'fork'
      ? ' This skill runs with context: \'fork\' — the executor will fork a subagent.'
      : '';

  const instruction =
    `Use the \`skill\` tool with {"name": "${skill.name}", "arguments": "${args}"} to dispatch this skill.${forkNote}`;

  const blocks: ContentBlockParam[] = [];
  if (manifestBlock && manifestBlock.trim().length > 0) {
    blocks.push({ type: 'text', text: manifestBlock });
  }
  blocks.push({ type: 'text', text: breadcrumb });
  blocks.push({ type: 'text', text: instruction });
  appendImageBlocks(blocks, attachments);
  return blocks;
}
