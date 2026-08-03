import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getInboundAttachmentsDir } from '../../paths.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { appendImageBlocks, type ImageBlockAttachment } from './image-blocks.js';

export type InboundMediaType = ImageBlockAttachment['mediaType'];

export interface InboundAttachmentRecord {
  readonly path: string;
  readonly mediaType: InboundMediaType;
  readonly sizeBytes: number;
}

export interface InboundAttachmentRegistration extends InboundAttachmentRecord {
  readonly id: string;
}

export interface InboundAttachmentReader {
  get(sessionId: string, id: string): InboundAttachmentRecord | undefined;
  listIds(sessionId: string): string[];
}

type HashBytes = (bytes: Buffer) => string;

const INITIAL_HASH_HEX_LENGTH = 6;
const sessions = new Map<string, Map<string, InboundAttachmentRecord>>();

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function formatInboundImageMarker(
  id: string,
  mediaType: InboundMediaType,
  sizeBytes: number,
): string {
  const kilobytes = Math.max(1, Math.round(sizeBytes / 1024));
  return `[image ${id} · ${mediaType} · ${kilobytes} KB]`;
}

export async function registerInboundImageBlocks(
  blocks: ContentBlockParam[],
  sessionId: string,
  attachments: readonly ImageBlockAttachment[],
  registry: InboundAttachmentRegistry = inboundAttachmentRegistry,
): Promise<void> {
  for (const attachment of attachments) {
    const registered = await registry.put(sessionId, attachment.bytes, attachment.mediaType);
    blocks.push({
      type: 'text',
      text: formatInboundImageMarker(registered.id, registered.mediaType, registered.sizeBytes),
    });
    appendImageBlocks(blocks, [attachment]);
  }
}

export class InboundAttachmentRegistry implements InboundAttachmentReader {
  constructor(
    private readonly entries = sessions,
    private readonly hashBytes: HashBytes = sha256,
  ) {}

  get(sessionId: string, id: string): InboundAttachmentRecord | undefined {
    return this.entries.get(sessionId)?.get(id);
  }

  listIds(sessionId: string): string[] {
    return [...(this.entries.get(sessionId)?.keys() ?? [])].sort();
  }

  /**
   * Evict all entry keys held for `sessionId`, freeing the module-level
   * `sessions` Map so terminated sessions don't leak image records forever.
   * Called from the `SessionEnd` hook (default-hook-registry.ts) — every
   * forked child owns its own `AgentSession.sessionId`, so a subagent's
   * SessionEnd clears its own (empty) bucket without touching the parent's.
   */
  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  async put(
    sessionId: string,
    bytes: Buffer,
    mediaType: InboundMediaType,
  ): Promise<InboundAttachmentRegistration> {
    const digest = this.hashBytes(bytes);
    const sessionEntries = this.entries.get(sessionId) ?? new Map<string, InboundAttachmentRecord>();
    this.entries.set(sessionId, sessionEntries);

    let hexLength = INITIAL_HASH_HEX_LENGTH;
    let suffix = 0;
    while (true) {
      const base = `img_${digest.slice(0, hexLength)}`;
      const id = suffix === 0 ? base : `${base}_${suffix}`;
      const existing = sessionEntries.get(id);
      if (existing === undefined) {
        const dir = getInboundAttachmentsDir(sessionId);
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${id}${extensionFor(mediaType)}`);
        await writeFile(path, bytes);
        const record = { path, mediaType, sizeBytes: bytes.byteLength };
        sessionEntries.set(id, record);
        return { id, ...record };
      }

      if (existing.mediaType === mediaType && (await readFile(existing.path)).equals(bytes)) {
        return { id, ...existing };
      }

      // Contract: a short-prefix collision with different bytes is never aliased.
      // Lengthen by two hex characters; only a full-digest collision uses a suffix.
      if (hexLength < digest.length) hexLength = Math.min(digest.length, hexLength + 2);
      else suffix += 1;
    }
  }
}

function extensionFor(mediaType: InboundMediaType): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
  }
}

export const inboundAttachmentRegistry = new InboundAttachmentRegistry();
