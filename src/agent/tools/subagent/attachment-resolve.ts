/** Resolve path-backed subagent image attachments under the parent's read policy. */
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ImageBlockAttachment } from '../../content/image-blocks.js';
import { resolveAndContain } from '../handlers/_cwd-utils.js';
import type { ToolHandlerContext } from '../types.js';

export const MAX_SUBAGENT_ATTACHMENT_COUNT = 8;
export const MAX_SUBAGENT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPES = new Map<string, ImageBlockAttachment['mediaType']>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

function byteCapExceeded(): Error {
  return new Error(
    `Agent tool image attachments exceed the ${MAX_SUBAGENT_ATTACHMENT_BYTES} byte (5 MiB) total limit`,
  );
}

export interface ResolveSubagentAttachmentsArgs {
  paths: readonly string[];
  resolveBase: string | undefined;
  readRoots: string[] | undefined;
}

export async function resolveSubagentAttachments(
  args: ResolveSubagentAttachmentsArgs,
): Promise<ImageBlockAttachment[]> {
  if (args.paths.length > MAX_SUBAGENT_ATTACHMENT_COUNT) {
    throw new Error(
      `Agent tool supports at most ${MAX_SUBAGENT_ATTACHMENT_COUNT} image attachments per dispatch`,
    );
  }

  const context: ToolHandlerContext = {
    ...(args.resolveBase !== undefined ? { resolveBase: args.resolveBase } : {}),
    ...(args.readRoots !== undefined ? { readRoots: args.readRoots } : {}),
  };
  const attachments: ImageBlockAttachment[] = [];
  let totalBytes = 0;

  for (const inputPath of args.paths) {
    const mediaType = MEDIA_TYPES.get(extname(inputPath).toLowerCase());
    // Future magic-byte unification point: sniffMimeType in telegram/handlers/message.ts.
    if (mediaType === undefined) {
      throw new Error(
        `Unsupported image attachment ${JSON.stringify(inputPath)}; expected .jpg, .jpeg, .png, .gif, or .webp`,
      );
    }
    const resolvedPath = resolveAndContain(inputPath, context, 'read');

    // Invariant: stat before read. The byte cap must reject an oversized file
    // BEFORE its contents enter memory — checking only after readFile would let
    // a single multi-gigabyte path exhaust the heap on the way to being
    // refused. stat() supplies the projected total; the post-read check below
    // is the consistency backstop for a file that grows between the two calls.
    const projected = totalBytes + (await stat(resolvedPath)).size;
    if (projected > MAX_SUBAGENT_ATTACHMENT_BYTES) throw byteCapExceeded();

    const bytes = await readFile(resolvedPath);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SUBAGENT_ATTACHMENT_BYTES) throw byteCapExceeded();
    attachments.push({ mediaType, bytes });
  }
  return attachments;
}
