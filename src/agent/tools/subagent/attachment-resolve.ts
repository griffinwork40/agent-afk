/** Resolve path-backed subagent image attachments under the parent's read policy. */
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import type { InboundAttachmentReader } from '../../content/attachment-registry.js';
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
  sessionId?: string;
  registry?: InboundAttachmentReader;
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
    let registered: { path: string; mediaType: ImageBlockAttachment['mediaType']; sizeBytes: number } | undefined;
    if (!isAbsolute(inputPath)) {
      registered = args.sessionId === undefined ? undefined : args.registry?.get(args.sessionId, inputPath);
      if (registered === undefined) {
        const available = args.sessionId === undefined ? [] : (args.registry?.listIds(args.sessionId) ?? []);
        throw new Error(
          `Unknown inbound image id ${JSON.stringify(inputPath)}; available ids for this session: ` +
          (available.length > 0 ? available.join(', ') : '(none)'),
        );
      }
    }
    const attachmentPath = registered?.path ?? inputPath;
    const mediaType = registered?.mediaType ?? MEDIA_TYPES.get(extname(attachmentPath).toLowerCase());
    // Future magic-byte unification point: sniffMimeType in telegram/handlers/message.ts.
    if (mediaType === undefined) {
      throw new Error(
        `Unsupported image attachment ${JSON.stringify(inputPath)}; expected .jpg, .jpeg, .png, .gif, or .webp`,
      );
    }
    // Registry paths were created by this process under the validated session
    // sidecar dir; human-supplied absolute paths still pass the read-root policy.
    const resolvedPath = registered === undefined
      ? resolveAndContain(attachmentPath, context, 'read')
      : attachmentPath;

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
